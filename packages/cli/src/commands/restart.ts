import colors from 'ansi-colors';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { generateBranchName } from '../utils/branch-name.js';
import {
  UserSettingsManager,
  IterationManager,
  AI_AGENT,
  Git,
  ProjectConfigManager,
  showTitle,
  showProperties,
  launchSync,
  type ProjectManager,
} from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import { exitWithError, exitWithSuccess } from '../utils/exit.js';
import { createSandbox } from '../lib/sandbox/index.js';
import type { TaskRestartOutput } from '../output-types.js';
import { getTelemetry } from '../lib/telemetry.js';
import {
  isJsonMode,
  setJsonMode,
  requireProjectContext,
} from '../lib/context.js';
import yoctoSpinner from 'yocto-spinner';
import { copyEnvironmentFiles } from '../utils/env-files.js';
import type { CommandDefinition } from '../types.js';
import { acquireResumeLock } from '../lib/resume-helper.js';

/**
 * Restart a task that is in NEW or FAILED status.
 *
 * Re-executes a task that either never started (NEW) or previously failed.
 * Resets the task state, ensures the git worktree exists, and spawns a new
 * sandboxed container to run the AI agent. Useful for retrying tasks after
 * fixing configuration issues or transient failures.
 *
 * @param taskId - The numeric task ID to restart
 * @param options - Command options
 * @param options.json - Output results in JSON format
 */
const restartCommand = async (
  taskId: string,
  options: { json?: boolean } = {}
) => {
  if (options.json !== undefined) {
    setJsonMode(options.json);
  }

  const telemetry = getTelemetry();

  let jsonOutput: TaskRestartOutput = {
    success: false,
  };

  // Convert string taskId to number (strict: reject '123abc' etc.)
  if (!/^\d+$/.test(taskId)) {
    jsonOutput.error = `Invalid task ID '${taskId}' - must be a number`;
    await exitWithError(jsonOutput, { telemetry });
    return;
  }
  const numericTaskId = parseInt(taskId, 10);

  // Require project context
  let project;
  try {
    project = await requireProjectContext();
  } catch (error) {
    jsonOutput.error = error instanceof Error ? error.message : String(error);
    await exitWithError(jsonOutput, { telemetry });
    return;
  }

  try {
    // Load task using ProjectManager
    const task = project.getTask(numericTaskId);
    if (!task) {
      throw new TaskNotFoundError(numericTaskId);
    }

    // Check if task is in a restartable status
    if (!task.isNew() && !task.isFailed()) {
      if (task.isInProgress() || task.isIterating()) {
        // Allow restarting IN_PROGRESS/ITERATING tasks if the container is dead
        try {
          const sandbox = await createSandbox(task, undefined, {
            projectPath: project.path,
            sandboxMetadata: task.sandboxMetadata,
          });
          const state = await sandbox.inspect();
          // Container is still alive — reject the restart
          const containerStatus = (state?.status ?? '').toLowerCase();
          if (
            containerStatus === 'running' ||
            containerStatus === 'created' ||
            containerStatus === 'restarting' ||
            containerStatus === 'paused'
          ) {
            jsonOutput.error = `Task ${taskId} is ${task.status} and its container is still running`;
            await exitWithError(jsonOutput, {
              tips: [
                'The container for this task is still running',
                'Use ' +
                  colors.cyan(`rover logs -f ${taskId}`) +
                  colors.gray(' to watch the task logs'),
              ],
              telemetry,
            });
            return;
          }
          // Container is dead (exited or not found) — allow restart to proceed
        } catch (error) {
          const inspectError =
            error instanceof Error ? error.message : String(error);
          jsonOutput.error = `Could not verify whether task ${taskId} container is running: ${inspectError}`;
          await exitWithError(jsonOutput, {
            tips: [
              'Rover could not inspect the existing task container, so restart was blocked to avoid duplicate runs',
              'Use ' +
                colors.cyan(`rover inspect ${taskId}`) +
                colors.gray(' to check the current task status'),
              'Use ' +
                colors.cyan(`rover stop ${taskId}`) +
                colors.gray(
                  ' if you are certain the task is stuck, then run restart again'
                ),
            ],
            telemetry,
          });
          return;
        }
      } else {
        jsonOutput.error = `Task ${taskId} is not in NEW or FAILED status (current: ${task.status})`;
        const tips = [
          'Only NEW, FAILED, and stuck IN_PROGRESS/ITERATING tasks can be restarted',
          'Use ' +
            colors.cyan(`rover inspect ${taskId}`) +
            colors.gray(' to find out the current task status'),
        ];
        if (task.isPaused()) {
          tips.unshift(
            'Use ' +
              colors.cyan(`rover resume ${taskId}`) +
              colors.gray(' to resume a paused task from its last checkpoint')
          );
        }
        await exitWithError(jsonOutput, { tips, telemetry });
        return;
      }
    }

    const previousStatus = task.status;
    const previousError = task.error;
    const restorePreRestartStatus = () => {
      if (previousStatus === 'FAILED' && previousError) {
        task.setStatus(previousStatus, { error: previousError });
        return;
      }
      task.setStatus(previousStatus);
    };

    // Defer task.restart() until after lock acquisition to avoid a window
    // where the task is IN_PROGRESS on disk without concurrency protection.
    const restartedAt = new Date().toISOString();

    // Load AI agent selection from user settings
    let selectedAiAgent = AI_AGENT.Claude; // default

    try {
      if (UserSettingsManager.exists(project.path)) {
        const userSettings = UserSettingsManager.load(project.path);
        selectedAiAgent = userSettings.defaultAiAgent || AI_AGENT.Claude;
      }
    } catch (error) {
      if (!isJsonMode()) {
        console.log(
          colors.yellow('⚠ Could not load user settings, defaulting to Claude')
        );
      }
      selectedAiAgent = AI_AGENT.Claude;
    }

    // Ensure iterations directory exists
    const iterationPath = join(
      task.iterationsPath(),
      task.iterations.toString()
    );
    mkdirSync(iterationPath, { recursive: true });

    // Acquire a restart lock to prevent concurrent restarts from racing.
    // Uses the same .resume.lock file as the resume command for mutual exclusion.
    // Must be acquired BEFORE any display output or status changes so the
    // status is not left stuck if the lock is already held.
    const releaseLock = acquireResumeLock(iterationPath);
    if (!releaseLock) {
      restorePreRestartStatus();
      jsonOutput.error = `Task is already being resumed or restarted by another process.`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    // All code between lock acquisition and sandbox completion must be
    // wrapped in try/finally to guarantee the lock is released even if
    // an unexpected error occurs (e.g. disk full, permission error).
    try {
      // Setup git worktree and branch if not already set.
      // This must happen under the restart lock so concurrent restarts cannot
      // recreate the same worktree/branch underneath each other.
      let worktreePath = task.worktreePath;
      let branchName = task.branchName;

      if (!worktreePath || !branchName) {
        worktreePath = project.getWorkspacePath(numericTaskId);
        branchName = generateBranchName(numericTaskId);

        const spinner = !isJsonMode()
          ? yoctoSpinner({ text: 'Setting up workspace...' }).start()
          : null;

        try {
          const git = new Git({ cwd: project.path });
          git.createWorktree(worktreePath, branchName);

          // Copy user .env development files
          copyEnvironmentFiles(project.path, worktreePath);

          // Configure sparse checkout to exclude files matching exclude patterns
          const projectConfig = ProjectConfigManager.load(project.path);
          if (
            projectConfig.excludePatterns &&
            projectConfig.excludePatterns.length > 0
          ) {
            git.setupSparseCheckout(
              worktreePath,
              projectConfig.excludePatterns
            );
          }

          // Update task with workspace information
          task.setWorkspace(worktreePath, branchName);

          if (spinner) spinner.success('Workspace setup complete');
        } catch (error) {
          if (spinner) spinner.error('Workspace setup failed');
          // Clean up the partially-created worktree so the next restart
          // attempt can recreate it cleanly.
          if (worktreePath && existsSync(worktreePath)) {
            try {
              launchSync(
                'git',
                ['worktree', 'remove', '--force', worktreePath],
                {
                  cwd: project.path,
                  reject: false,
                }
              );
            } catch {
              // Best-effort cleanup — the worktree may not have been
              // fully registered with git yet.
            }
          }
          // Restore the pre-restart status so the task remains in its
          // original state (e.g. FAILED) and can be retried.
          try {
            restorePreRestartStatus();
          } catch (rollbackError) {
            console.error(
              colors.yellow(
                `⚠ Failed to rollback task status: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
              )
            );
          }
          jsonOutput.error = `Failed to set up workspace: ${error instanceof Error ? error.message : String(error)}`;
          await exitWithError(jsonOutput, { telemetry });
          return;
        }
      }

      // Now that the lock is held, restart the task (sets status to
      // IN_PROGRESS and tracks the restart attempt). This prevents a
      // window where the task is IN_PROGRESS without concurrency
      // protection from the lock.
      task.restart(restartedAt);

      // Create initial iteration.json if it doesn't exist
      const iterationJsonPath = join(iterationPath, 'iteration.json');
      if (!existsSync(iterationJsonPath)) {
        IterationManager.createInitial(
          iterationPath,
          task.id,
          task.title,
          task.description
        );
      }

      if (!isJsonMode()) {
        showTitle('Restarting Task');
        const props: Record<string, string> = {
          ID: colors.cyan(task.id.toString()),
          Title: task.title,
          Status: colors.red(task.status),
          Workspace: colors.cyan(worktreePath),
          Branch: colors.cyan(branchName),
        };
        if (process.env.ROVER_AGENT_IMAGE) {
          props['Agent Image'] = colors.cyan(process.env.ROVER_AGENT_IMAGE);
        }
        props['Reset to'] = colors.yellow('NEW');
        showProperties(props);
        console.log(colors.green('\n✓ Task reset successfully'));
        console.log('');
      }

      // Mark task as in progress
      task.markInProgress();

      // Track restart event
      telemetry?.eventRestartTask();

      // Override agent image from environment variable if set
      if (process.env.ROVER_AGENT_IMAGE) {
        task.setAgentImage(process.env.ROVER_AGENT_IMAGE);
      }

      // Start sandbox container for task execution.
      // The lock is held until container metadata is persisted so another
      // process cannot acquire it before the container is fully registered.
      try {
        const sandbox = await createSandbox(task, undefined, {
          projectPath: project.path,
          sandboxMetadata: task.sandboxMetadata,
          iterationLogsPath: project.getTaskIterationLogsPath(
            task.id,
            task.iterations
          ),
        });
        const containerId = await sandbox.createAndStart();
        const sandboxMetadata =
          typeof sandbox.getSandboxMetadata === 'function'
            ? sandbox.getSandboxMetadata()
            : process.env.DOCKER_HOST
              ? { dockerHost: process.env.DOCKER_HOST }
              : undefined;

        // Update task metadata with new container ID
        task.setContainerInfo(containerId, 'running', sandboxMetadata);
      } catch (error) {
        // If sandbox execution fails, restore the pre-restart task status.
        try {
          restorePreRestartStatus();
        } catch (rollbackError) {
          console.error(
            colors.yellow(
              `⚠ Failed to rollback task status: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            )
          );
        }
        throw error;
      }
    } finally {
      releaseLock();
    }

    // Output final JSON after all operations are complete
    jsonOutput = {
      ...jsonOutput,
      success: true,
      taskId: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      restartedAt: restartedAt,
    };

    await exitWithSuccess('Task restarted successfully!', jsonOutput, {
      tips: [
        'Use ' + colors.cyan('rover list') + ' to check the list of tasks',
        'Use ' +
          colors.cyan(`rover logs -f ${task.id}`) +
          ' to watch the task logs',
        'Use ' +
          colors.cyan(`rover inspect ${task.id}`) +
          ' to check the task status',
      ],
      telemetry,
    });

    return;
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      jsonOutput.error = `The task with ID ${numericTaskId} was not found`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    } else {
      jsonOutput.error = `There was an error restarting the task: ${error}`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }
  } finally {
    await Promise.race([
      telemetry?.shutdown(),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }
};

// Named export for backwards compatibility (used by tests)
export { restartCommand };

export default {
  name: 'restart',
  description: 'Restart a new, failed, or stuck in-progress/iterating task',
  requireProject: true,
  action: restartCommand,
} satisfies CommandDefinition;
