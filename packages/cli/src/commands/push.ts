import colors from 'ansi-colors';
import enquirer from 'enquirer';
import yoctoSpinner from 'yocto-spinner';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProjectConfigManager,
  Git,
  showTitle,
  showProperties,
} from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import { getTelemetry } from '../lib/telemetry.js';
import type { TaskPushOutput } from '../output-types.js';
import { exitWithError, exitWithSuccess, exitWithWarn } from '../utils/exit.js';
import {
  isJsonMode,
  setJsonMode,
  requireProjectContext,
} from '../lib/context.js';
import { showRoverChat, TIP_TITLES } from '../utils/display.js';
import { statusColor } from '../utils/task-status.js';
import { executeHooks } from '../lib/hooks.js';
import type { CommandDefinition } from '../types.js';
import { getWorkspaceRepositories } from '../lib/workspace-repositories.js';

const { prompt } = enquirer;

interface PushOptions {
  message?: string;
  pr?: boolean;
  json?: boolean;
}

interface RepoInfo {
  provider: 'github' | 'gitlab';
  host: string;
  projectPath: string;
}

interface PushTarget {
  label: string;
  branchName: string;
  worktreePath: string;
  remoteUrl: string;
}

/**
 * Get repository info (provider, host, project path) from a git remote URL.
 * Supports GitHub and GitLab, including self-hosted instances and SSH aliases.
 */
export const getRepoInfo = (remoteUrl: string): RepoInfo | null => {
  let host: string;
  let pathPart: string;

  // SCP-style: git@host:path/to/repo.git
  const scpMatch = remoteUrl.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (scpMatch) {
    host = scpMatch[1];
    pathPart = scpMatch[2];
  } else {
    // URL-style: https://host/path/to/repo.git
    const urlMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (urlMatch) {
      host = urlMatch[1];
      pathPart = urlMatch[2];
    } else {
      return null;
    }
  }

  // Determine provider from hostname
  const hostLower = host.toLowerCase();
  if (hostLower.includes('github')) {
    return {
      provider: 'github',
      host: hostLower.includes('.') ? host : 'github.com',
      projectPath: pathPart,
    };
  }

  if (hostLower.includes('gitlab')) {
    return {
      provider: 'gitlab',
      host: hostLower.includes('.') ? host : 'gitlab.com',
      projectPath: pathPart,
    };
  }

  return null;
};

/**
 * Commit and push a task's changes to the remote repository.
 *
 * Stages all changes in the task worktree, commits them with a provided or
 * prompted message (including Rover co-author attribution if enabled), and
 * pushes the task branch to the remote. Sets up upstream tracking if needed.
 * Triggers onPush hooks after successful pushes.
 *
 * @param taskId - The numeric task ID to push
 * @param options - Command options
 * @param options.message - Commit message (prompts if not provided)
 * @param options.pr - Reserved for future GitHub PR creation support
 * @param options.json - Output results in JSON format
 */
const pushCommand = async (taskId: string, options: PushOptions) => {
  if (options.json !== undefined) {
    setJsonMode(options.json);
  }

  const telemetry = getTelemetry();
  const json = options.json === true;
  const result: TaskPushOutput = {
    success: false,
    taskId: 0,
    taskTitle: '',
    branchName: '',
    hasChanges: false,
    committed: false,
    pushed: false,
  };

  // Convert string taskId to number (strict: reject '123abc' etc.)
  if (!/^\d+$/.test(taskId)) {
    result.error = `Invalid task ID '${taskId}' - must be a number`;
    await exitWithError(result, { telemetry });
    return;
  }
  const numericTaskId = parseInt(taskId, 10);

  // Store the task ID!
  result.taskId = numericTaskId;

  // Get project context
  let project;
  try {
    project = await requireProjectContext();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    await exitWithError(result, { telemetry });
    return;
  }

  const git = new Git({ cwd: project.path });

  // Load config
  const projectConfig = ProjectConfigManager.load(project.path);

  try {
    // Load task using ProjectManager
    const task = project.getTask(numericTaskId);
    if (!task) {
      throw new TaskNotFoundError(numericTaskId);
    }

    result.taskTitle = task.title;
    result.branchName = task.branchName;

    // Reject push for tasks that are still actively running or paused to prevent
    // collapsing in-flight work from a running container.
    if (task.isInProgress() || task.isIterating() || task.isPaused()) {
      result.error = `Task ${taskId} is ${task.status} — wait for it to finish or stop it before pushing`;
      await exitWithError(result, {
        tips: [
          'Use ' +
            colors.cyan(`rover logs -f ${taskId}`) +
            colors.gray(' to watch the task logs'),
          'Use ' +
            colors.cyan(`rover inspect ${taskId}`) +
            colors.gray(' to check the current task status'),
        ],
        telemetry,
      });
      return;
    }

    if (!task.worktreePath || !existsSync(task.worktreePath)) {
      result.error = 'Task workspace not found';
      await exitWithError(result, { telemetry });
      return;
    }

    if (!isJsonMode()) {
      showRoverChat(["We are good to go. Let's push the changes."]);

      const colorFunc = statusColor(task.status);

      showTitle('Push task changes');
      showProperties({
        ID: colors.cyan(task.id.toString()),
        Title: task.title,
        Branch: task.branchName,
        Status: colorFunc(task.status),
      });
    }

    const pushTargets: PushTarget[] = [
      {
        label: 'root workspace',
        branchName: task.branchName,
        worktreePath: task.worktreePath,
        remoteUrl: git.remoteUrl({ worktreePath: task.worktreePath }),
      },
      ...getWorkspaceRepositories(task.worktreePath, projectConfig)
        .filter(repo => existsSync(join(repo.worktreePath, '.git')))
        .map(repo => ({
          label: repo.name,
          branchName:
            git.getCurrentBranch({ worktreePath: repo.worktreePath }) ||
            task.branchName,
          worktreePath: repo.worktreePath,
          remoteUrl: git.remoteUrl({ worktreePath: repo.worktreePath }),
        })),
    ];

    const hasAnyLocalChanges = pushTargets.some(target => {
      const changes = git.uncommittedChanges({
        worktreePath: target.worktreePath,
      });
      return changes.length > 0;
    });

    const hasAnyUnpushedCommits = pushTargets.some(target => {
      try {
        return git.hasUnmergedCommits(target.branchName, {
          targetBranch: `origin/${target.branchName}`,
          worktreePath: target.worktreePath,
        });
      } catch {
        return true;
      }
    });

    result.hasChanges = hasAnyLocalChanges;

    if (!hasAnyLocalChanges && !hasAnyUnpushedCommits) {
      result.success = true;
      await exitWithWarn('No changes to push', result, { telemetry });
      return;
    }

    let commitMessage = options.message;
    if (hasAnyLocalChanges) {
      // Get commit message
      if (!commitMessage) {
        const defaultMessage = `Task ${numericTaskId}: ${task.title}`;
        if (isJsonMode()) {
          commitMessage = defaultMessage;
        } else {
          try {
            const { message } = await prompt<{ message: string }>({
              type: 'input',
              name: 'message',
              message: 'Commit message:',
              initial: defaultMessage,
            });
            commitMessage = message;
          } catch (err) {
            console.log(
              colors.yellow(
                '\n⚠ Commit message skipped. Using default message.'
              )
            );
            commitMessage = defaultMessage;
          }
        }
      }

      if (projectConfig == null || projectConfig?.attribution === true) {
        commitMessage = `${commitMessage}\n\nCo-Authored-By: Rover <noreply@endor.dev>`;
      }

      result.commitMessage = commitMessage;
      for (const target of pushTargets) {
        const hasLocalChanges =
          git.uncommittedChanges({ worktreePath: target.worktreePath }).length >
          0;
        if (!hasLocalChanges) {
          continue;
        }

        const commitSpinner = !options.json
          ? yoctoSpinner({
              text: `Committing changes in ${target.label}...`,
            }).start()
          : null;
        try {
          git.addAndCommit(commitMessage, {
            worktreePath: target.worktreePath,
          });
          result.committed = true;
          commitSpinner?.success(`Changes committed in ${target.label}`);
        } catch (error: unknown) {
          result.error = `Failed to commit changes in ${target.label}: ${error instanceof Error ? error.message : String(error)}`;
          commitSpinner?.error(`Failed to commit ${target.label}`);
          await exitWithError(result, { telemetry });
          return;
        }
      }
    }

    telemetry?.eventPushBranch();

    const pushedTargets: string[] = [];
    for (const target of pushTargets) {
      const pushSpinner = !options.json
        ? yoctoSpinner({
            text: `Pushing ${target.branchName} from ${target.label}...`,
          }).start()
        : null;
      try {
        git.push(target.branchName, {
          worktreePath: target.worktreePath,
        });
        result.pushed = true;
        pushedTargets.push(target.label);
        pushSpinner?.success(`Pushed ${target.label}`);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('has no upstream branch')) {
          if (pushSpinner) {
            pushSpinner.text = `Setting upstream for ${target.label}...`;
          }

          try {
            git.push(target.branchName, {
              setUpstream: true,
              worktreePath: target.worktreePath,
            });
            result.pushed = true;
            pushedTargets.push(target.label);
            pushSpinner?.success(`Pushed ${target.label}`);
          } catch (retryError: unknown) {
            pushSpinner?.error(`Failed to push ${target.label}`);
            if (pushedTargets.length > 0 && !isJsonMode()) {
              console.log(
                colors.yellow(
                  `⚠ Already pushed: ${pushedTargets.join(', ')}. These were NOT rolled back.`
                )
              );
            }
            result.error = `Failed to push ${target.label}: ${retryError instanceof Error ? retryError.message : String(retryError)}`;
            await exitWithError(result, { telemetry });
            return;
          }
        } else {
          pushSpinner?.error(`Failed to push ${target.label}`);
          if (pushedTargets.length > 0 && !isJsonMode()) {
            console.log(
              colors.yellow(
                `⚠ Already pushed: ${pushedTargets.join(', ')}. These were NOT rolled back.`
              )
            );
          }
          result.error = `Failed to push ${target.label}: ${errorMessage}`;
          await exitWithError(result, { telemetry });
          return;
        }
      }
    }
    task.markPushed(); // Set status to PUSHED

    let repoInfo: RepoInfo | null = null;

    try {
      const remoteUrl = pushTargets[0]?.remoteUrl ?? '';
      repoInfo = getRepoInfo(remoteUrl);
    } catch (_err) {
      // Ignore the error
    }

    // Execute onPush hooks if configured
    if (projectConfig?.hooks?.onPush?.length) {
      executeHooks(
        projectConfig.hooks.onPush,
        {
          taskId: numericTaskId,
          taskBranch: task.branchName,
          taskTitle: task.title,
          projectPath: project.path,
        },
        'onPush'
      );
    }

    result.success = true;

    const tips = [];
    if (repoInfo != null) {
      if (repoInfo.provider === 'github') {
        tips.push(
          'You can open a new PR on ' +
            colors.cyan(
              `https://${repoInfo.host}/${repoInfo.projectPath}/pull/new/${encodeURIComponent(task.branchName)}`
            )
        );
      } else {
        tips.push(
          'You can open a new merge request on ' +
            colors.cyan(
              `https://${repoInfo.host}/${repoInfo.projectPath}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(task.branchName)}`
            )
        );
      }
    }

    await exitWithSuccess('Push completed successfully!', result, {
      tips,
      tipsConfig: {
        title: TIP_TITLES.NEXT_STEPS,
      },
      telemetry,
    });
  } catch (error: unknown) {
    if (error instanceof TaskNotFoundError) {
      result.error = `The task with ID ${numericTaskId} was not found`;
      await exitWithError(result, { telemetry });
    } else {
      result.error = `There was an error pushing the task: ${error}`;
      await exitWithError(result, { telemetry });
    }
  } finally {
    await telemetry?.shutdown();
  }
};

export default {
  name: 'push',
  description: 'Commit and push task changes to remote',
  requireProject: true,
  action: pushCommand,
} satisfies CommandDefinition;
