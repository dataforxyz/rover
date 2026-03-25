import { existsSync } from 'node:fs';
import { join } from 'node:path';
import colors from 'ansi-colors';
import enquirer from 'enquirer';
import {
  AI_AGENT,
  Git,
  launchSync,
  ProjectConfigManager,
  UserSettingsManager,
} from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import yoctoSpinner from 'yocto-spinner';
import {
  type AIAgentTool,
  getAIAgentTool,
  getUserDefaultModel,
} from '../lib/agents/index.js';
import {
  isJsonMode,
  requireProjectContext,
  setJsonMode,
} from '../lib/context.js';
import {
  generateCommitMessage,
  getTaskIterationSummaries,
  resolveConflicts,
} from '../lib/merge-rebase-utils.js';
import { collapseTaskCommits } from '../lib/squash.js';
import { getTelemetry } from '../lib/telemetry.js';
import { getWorkspaceRepositories } from '../lib/workspace-repositories.js';
import type { CLIJsonOutput, CommandDefinition } from '../types.js';
import { parseAgentString } from '../utils/agent-parser.js';
import { showRoverChat } from '../utils/display.js';
import { exitWithError, exitWithSuccess, exitWithWarn } from '../utils/exit.js';

const { prompt } = enquirer;

/**
 * AI-powered rebase conflict resolver.
 * Delegates to the shared resolveConflicts utility with rebase-specific defaults.
 */
export const resolveRebaseConflicts = async (
  git: Git,
  conflictedFiles: string[],
  aiAgent: AIAgentTool,
  worktreePath: string,
  concurrency: number = 4,
  contextLines: number = 50,
  sendFullFile: boolean = false
): Promise<{ success: boolean; failureReason?: string }> => {
  return resolveConflicts({
    git,
    conflictedFiles,
    aiAgent,
    rootPath: worktreePath,
    theirsRef: 'REBASE_HEAD',
    worktreePath,
    concurrency,
    contextLines,
    sendFullFile,
  });
};

interface RebaseOptions {
  agent?: string;
  base?: string;
  concurrency?: string;
  contextLines?: string;
  sendFullFile?: boolean;
  force?: boolean;
  json?: boolean;
}

interface TaskRebaseOutput extends CLIJsonOutput {
  taskId?: number;
  taskTitle?: string;
  branchName?: string;
  currentBranch?: string;
  hasWorktreeChanges?: boolean;
  committed?: boolean;
  commitMessage?: string;
  rebased?: boolean;
  conflictsResolved?: boolean;
}

interface RebaseTarget {
  label: string;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
}

const resolveSubprojectRebaseBase = (
  worktreePath: string,
  baseBranch: string
): string => {
  const remoteTrackingRef = `refs/remotes/origin/${baseBranch}`;
  const remoteRefResult = launchSync(
    'git',
    ['-C', worktreePath, 'show-ref', '--verify', '--quiet', remoteTrackingRef],
    { reject: false }
  );

  return remoteRefResult.exitCode === 0 ? `origin/${baseBranch}` : baseBranch;
};

/**
 * Rebase a task's branch onto the current branch.
 *
 * Handles the full rebase workflow: commits any uncommitted worktree changes
 * with an AI-generated commit message, rebases the task branch onto the current
 * branch, and handles conflicts using AI-powered resolution.
 *
 * @param taskId - The numeric task ID to rebase
 * @param options - Command options
 * @param options.agent - AI agent with optional model (e.g., claude:sonnet)
 * @param options.force - Skip confirmation prompt
 * @param options.json - Output results in JSON format
 */
export const rebaseCommand = async (
  taskId: string,
  options: RebaseOptions = {}
) => {
  if (options.json !== undefined) {
    setJsonMode(options.json);
  }

  const telemetry = getTelemetry();
  const jsonOutput: TaskRebaseOutput = {
    success: false,
  };

  if (!/^\d+$/.test(taskId)) {
    jsonOutput.error = `Invalid task ID '${taskId}' - must be a number`;
    await exitWithError(jsonOutput, { telemetry });
    return;
  }
  const numericTaskId = Number(taskId);

  let project;
  try {
    project = await requireProjectContext();
  } catch (error) {
    jsonOutput.error = error instanceof Error ? error.message : String(error);
    await exitWithError(jsonOutput, { telemetry });
    return;
  }

  const git = new Git({ cwd: project.path });

  if (!git.isGitRepo()) {
    jsonOutput.error = 'Not a git repository';
    await exitWithError(jsonOutput, { telemetry });
    return;
  }

  if (!isJsonMode()) {
    showRoverChat(["Let's rebase the task branch onto your current branch"]);
  }

  jsonOutput.taskId = numericTaskId;

  // Load AI agent selection
  let selectedAiAgent = 'claude';
  let selectedModel: string | undefined;
  let projectConfig;

  try {
    projectConfig = ProjectConfigManager.load(project.path);
  } catch (err) {
    if (!isJsonMode()) {
      console.log(colors.yellow('⚠ Could not load project settings'));
    }
  }

  if (options.agent) {
    const parsed = parseAgentString(options.agent);
    selectedAiAgent = parsed.agent;
    selectedModel = parsed.model;
  } else {
    try {
      if (UserSettingsManager.exists(project.path)) {
        const userSettings = UserSettingsManager.load(project.path);
        selectedAiAgent = userSettings.defaultAiAgent || AI_AGENT.Claude;
      } else {
        if (!isJsonMode()) {
          console.log(
            colors.yellow('⚠ User settings not found, defaulting to Claude')
          );
          console.log(
            colors.gray('  Run `rover init` to configure AI agent preferences')
          );
        }
      }
    } catch (error) {
      if (!isJsonMode()) {
        console.log(
          colors.yellow('⚠ Could not load user settings, defaulting to Claude')
        );
      }
      selectedAiAgent = AI_AGENT.Claude;
    }

    selectedModel = getUserDefaultModel(selectedAiAgent as AI_AGENT);
  }

  const aiAgent = getAIAgentTool(selectedAiAgent, selectedModel);

  try {
    const task = project.getTask(numericTaskId);
    if (!task) {
      throw new TaskNotFoundError(numericTaskId);
    }

    jsonOutput.taskTitle = task.title;
    jsonOutput.branchName = task.branchName;

    if (!isJsonMode()) {
      console.log(colors.bold('Rebase Task'));
      console.log(colors.gray('├── ID: ') + colors.cyan(task.id.toString()));
      console.log(colors.gray('├── Title: ') + task.title);
      console.log(colors.gray('├── Worktree: ') + task.worktreePath);
      console.log(colors.gray('├── Branch: ') + task.branchName);
      console.log(colors.gray('└── Status: ') + task.status);
    }

    // Reject tasks in active or paused states
    if (task.isInProgress() || task.isIterating()) {
      jsonOutput.error = `Task ${taskId} is ${task.status} — cannot rebase while the agent is running`;
      await exitWithError(jsonOutput, {
        tips: [
          'Wait for the task to complete, or stop it first with ' +
            colors.cyan(`rover stop ${taskId}`),
        ],
        telemetry,
      });
      return;
    }

    // Paused tasks are safe to rebase — no running agent, worktree is idle.

    if (!task.worktreePath || !existsSync(task.worktreePath)) {
      jsonOutput.error = 'No worktree found for this task';
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    // Determine target branch: explicit --base flag, or fall back to current checkout
    const currentBranch = options.base || git.getCurrentBranch();
    jsonOutput.currentBranch = currentBranch;

    const workspaceRepositories =
      projectConfig && task.worktreePath
        ? getWorkspaceRepositories(task.worktreePath, projectConfig).filter(
            repo => existsSync(join(repo.worktreePath, '.git'))
          )
        : [];

    const rebaseTargets: RebaseTarget[] = [
      {
        label: 'root workspace',
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        baseBranch: currentBranch,
      },
      ...workspaceRepositories.map(repo => ({
        label: repo.name,
        branchName: task.branchName,
        worktreePath: repo.worktreePath,
        baseBranch:
          options.base ||
          repo.ref ||
          new Git({ cwd: repo.worktreePath }).getMainBranch(),
      })),
    ];

    for (const target of rebaseTargets) {
      const checkedOutBranch = git.getCurrentBranch({
        worktreePath: target.worktreePath,
      });
      if (checkedOutBranch === target.branchName) {
        continue;
      }

      try {
        git.checkoutBranch(target.branchName, {
          worktreePath: target.worktreePath,
          createIfMissing: true,
        });
      } catch (error) {
        jsonOutput.error = `Failed to switch ${target.label} to ${target.branchName}: ${error instanceof Error ? error.message : String(error)}`;
        await exitWithError(jsonOutput, { telemetry });
        return;
      }
    }

    // Check if any workspace repo has uncommitted changes (before squashing root)
    const hasUncommittedChanges = rebaseTargets.some(target =>
      git.hasUncommittedChanges({
        worktreePath: target.worktreePath,
      })
    );

    if (!isJsonMode()) {
      console.log('');
      console.log(colors.cyan('The rebase process will'));
      if (hasUncommittedChanges) {
        console.log(colors.cyan('├── Commit changes in the task worktree(s)'));
      }
      console.log(
        colors.cyan(`├── Rebase the task branch onto ${currentBranch}`)
      );
      console.log(colors.cyan('└── Resolve any conflicts if needed'));
    }

    // Confirm rebase unless force flag is used (skip in JSON mode)
    if (!options.force && !options.json) {
      try {
        const { confirm } = await prompt<{ confirm: boolean }>({
          type: 'confirm',
          name: 'confirm',
          message: 'Do you want to rebase this task?',
          initial: false,
        });

        if (!confirm) {
          jsonOutput.success = true;
          await exitWithWarn('Task rebase cancelled', jsonOutput, {
            telemetry,
          });
          return;
        }
      } catch (err) {
        jsonOutput.success = true;
        await exitWithWarn('Task rebase cancelled', jsonOutput, {
          telemetry,
        });
        return;
      }
    }

    if (!isJsonMode()) {
      console.log('');
    }

    // Collapse task commits AFTER user confirmation (this is destructive)
    const squashed = collapseTaskCommits(
      git,
      task.baseCommit,
      task.worktreePath
    );

    const hasWorktreeChanges = squashed || hasUncommittedChanges;

    jsonOutput.hasWorktreeChanges = hasWorktreeChanges;

    const spinner = !options.json
      ? yoctoSpinner({ text: 'Preparing rebase...' }).start()
      : null;

    try {
      let finalCommitMessage: string | undefined;
      const rebasedTargets: string[] = [];

      // Commit worktree changes if needed
      if (hasWorktreeChanges) {
        const recentCommits = git.getRecentCommits({
          branch: task.branchName,
          worktreePath: task.worktreePath,
        });
        const summaries = getTaskIterationSummaries(task.iterationsPath());

        if (spinner) spinner.text = 'Generating commit message with AI...';
        const aiCommitMessage = await generateCommitMessage(
          task.title,
          task.description,
          recentCommits,
          summaries,
          aiAgent
        );

        const commitMessage = aiCommitMessage || task.title;

        if (projectConfig == null || projectConfig?.attribution === true) {
          finalCommitMessage = `${commitMessage}\n\nCo-Authored-By: Rover <noreply@endor.dev>`;
        } else {
          finalCommitMessage = commitMessage;
        }

        jsonOutput.commitMessage = finalCommitMessage.split('\n')[0];

        for (const target of rebaseTargets) {
          const targetHasChanges = git.hasUncommittedChanges({
            worktreePath: target.worktreePath,
          });
          if (!targetHasChanges) {
            continue;
          }

          if (spinner) {
            spinner.text = `Committing changes in ${target.label}...`;
          }

          try {
            git.addAndCommit(finalCommitMessage, {
              worktreePath: target.worktreePath,
            });
            jsonOutput.committed = true;
          } catch (error) {
            jsonOutput.committed = false;
            spinner?.error('Failed to commit changes');
            if (rebasedTargets.length > 0 && !isJsonMode()) {
              console.log(
                colors.yellow(
                  `⚠ Already rebased: ${rebasedTargets.join(', ')}. These were NOT rolled back.`
                )
              );
            }
            jsonOutput.error = `Failed to add and commit changes in ${target.label}`;
            await exitWithError(jsonOutput, { telemetry });
            return;
          }
        }
      }

      for (const target of rebaseTargets) {
        if (target.label !== 'root workspace') {
          if (spinner) {
            spinner.text = `Fetching ${target.baseBranch} in ${target.label}...`;
          }
          try {
            launchSync('git', [
              '-C',
              target.worktreePath,
              'fetch',
              'origin',
              target.baseBranch,
            ]);
          } catch {
            // Best-effort: if fetch fails, continue with local ref
          }
        }

        if (spinner) {
          spinner.text = `Rebasing ${target.label} onto ${target.baseBranch}...`;
        }

        const rebaseOnto =
          target.label !== 'root workspace'
            ? resolveSubprojectRebaseBase(
                target.worktreePath,
                target.baseBranch
              )
            : target.baseBranch;

        const rebaseResult = git.rebaseBranch(rebaseOnto, {
          worktreePath: target.worktreePath,
        });

        if (rebaseResult.success) {
          jsonOutput.rebased = true;
          rebasedTargets.push(target.label);
          continue;
        }

        const rebaseConflicts = git.getMergeConflicts({
          worktreePath: target.worktreePath,
        });

        if (rebaseConflicts.length > 0) {
          if (spinner) spinner.error('Rebase conflicts detected');

          if (!isJsonMode()) {
            console.log(
              colors.yellow(
                `\n⚠ Rebase conflicts detected in ${target.label} (${rebaseConflicts.length} file(s)):`
              )
            );
            rebaseConflicts.forEach((file, index) => {
              const isLast = index === rebaseConflicts.length - 1;
              const connector = isLast ? '└──' : '├──';
              console.log(colors.gray(connector), file);
            });
          }

          if (!isJsonMode()) {
            showRoverChat([
              'I noticed some rebase conflicts. I will try to solve them',
            ]);
          }

          const concurrency = Math.max(
            1,
            Math.min(parseInt(options.concurrency || '4', 10) || 4, 16)
          );
          const contextLinesNum = Math.max(
            0,
            Math.min(parseInt(options.contextLines || '50', 10) || 50, 500)
          );
          const resolution = await resolveRebaseConflicts(
            git,
            rebaseConflicts,
            aiAgent,
            target.worktreePath,
            concurrency,
            contextLinesNum,
            options.sendFullFile === true
          );

          if (resolution.success) {
            jsonOutput.conflictsResolved = true;

            if (!isJsonMode() && !options.force) {
              showRoverChat([
                'The rebase conflicts are fixed. You can check the file content to confirm it.',
              ]);

              let applyChanges = false;

              try {
                const { confirmResolution } = await prompt<{
                  confirmResolution: boolean;
                }>({
                  type: 'confirm',
                  name: 'confirmResolution',
                  message: 'Do you want to continue with the rebase?',
                  initial: false,
                });
                applyChanges = confirmResolution;
              } catch (error) {
                // Ignore the error as it's a regular CTRL+C
              }

              if (!applyChanges) {
                git.abortRebase({ worktreePath: target.worktreePath });
                await exitWithWarn(
                  'User rejected AI resolution. Rebase aborted',
                  jsonOutput,
                  { telemetry }
                );
                return;
              }
            }

            // Continue the rebase with resolved conflicts
            try {
              git.continueRebase({ worktreePath: target.worktreePath });

              jsonOutput.rebased = true;

              if (!isJsonMode()) {
                console.log(
                  colors.green(
                    '\n✓ Rebase conflicts resolved and rebase completed'
                  )
                );
              }
            } catch (continueError) {
              git.abortRebase({ worktreePath: target.worktreePath });

              jsonOutput.error = `Error completing rebase after conflict resolution: ${continueError}`;
              await exitWithError(jsonOutput, { telemetry });
              return;
            }
          } else {
            jsonOutput.error =
              resolution.failureReason ||
              'AI failed to resolve rebase conflicts';
            git.abortRebase({ worktreePath: target.worktreePath });

            if (!isJsonMode()) {
              console.log(
                colors.yellow('\n⚠ Rebase aborted due to conflicts.')
              );
              console.log(colors.gray('To resolve manually:'));
              console.log(
                colors.gray('├──'),
                colors.gray(
                  `1. cd ${target.worktreePath} && git rebase ${target.baseBranch}`
                )
              );
              console.log(
                colors.gray('├──'),
                colors.gray('2. Fix conflicts in the listed files')
              );
              console.log(
                colors.gray('├──'),
                colors.gray('3. Run: git add <resolved-files>')
              );
              console.log(
                colors.gray('└──'),
                colors.gray('4. Run: git rebase --continue')
              );
            }
            await exitWithError(jsonOutput, { telemetry });
            return;
          }
        } else {
          // Other rebase error, not conflicts — abort to restore worktree
          git.abortRebase({ worktreePath: target.worktreePath });
          if (spinner) spinner.error('Rebase failed');
          if (rebasedTargets.length > 0 && !isJsonMode()) {
            console.log(
              colors.yellow(
                `⚠ Already rebased: ${rebasedTargets.join(', ')}. These were NOT rolled back.`
              )
            );
          }
          jsonOutput.error =
            rebaseResult.error ||
            `Rebase failed with an unknown error in ${target.label}`;
          await exitWithError(jsonOutput, { telemetry });
          return;
        }
      }

      if (jsonOutput.rebased) {
        // Update baseCommit so `rover diff --base` excludes upstream changes
        const newBaseCommit = git.getCommitHash(currentBranch, {
          worktreePath: task.worktreePath,
        });
        if (!newBaseCommit) {
          console.log(
            colors.yellow(
              '⚠ Could not determine new base commit after rebase. Future diffs may include upstream changes.'
            )
          );
        } else {
          task.setBaseCommit(newBaseCommit);
        }

        jsonOutput.success = true;
        await exitWithSuccess(
          'Task branch has been successfully rebased onto your current branch',
          jsonOutput,
          {
            tips: [
              'The task branch is now up to date with ' +
                colors.cyan(currentBranch),
            ],
            telemetry,
          }
        );
        return;
      }
    } catch (error: any) {
      if (spinner) spinner.error('Rebase failed');
      jsonOutput.error = `Error during rebase: ${error.message}`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      jsonOutput.error = error.message;
      await exitWithError(jsonOutput, { telemetry });
    } else {
      jsonOutput.error = `Error rebasing task: ${error}`;
      await exitWithError(jsonOutput, { telemetry });
    }
  } finally {
    await telemetry?.shutdown();
  }
};

export default {
  name: 'rebase',
  description: 'Rebase the task branch onto your current branch',
  requireProject: true,
  action: rebaseCommand,
} satisfies CommandDefinition;
