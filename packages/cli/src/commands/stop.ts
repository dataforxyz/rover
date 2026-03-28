import { rmSync } from 'node:fs';
import colors from 'ansi-colors';
import { launch, ProcessManager } from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import {
  isJsonMode,
  requireProjectContext,
  setJsonMode,
} from '../lib/context.js';
import {
  createSandbox,
  isSandboxBackendUnavailableError,
} from '../lib/sandbox/index.js';
import { getTelemetry } from '../lib/telemetry.js';
import type { TaskStopOutput } from '../output-types.js';
import type { CommandDefinition } from '../types.js';
import { exitWithError, exitWithSuccess, exitWithWarn } from '../utils/exit.js';

/**
 * Stop a running task and optionally clean up its resources.
 *
 * Terminates an in-progress task by stopping its Docker container. Can also
 * remove associated resources like the container, git worktree, and branch.
 * Useful for cancelling stuck tasks or freeing up system resources.
 *
 * @param taskId - The numeric task ID to stop
 * @param options - Command options
 * @param options.json - Output results in JSON format
 * @param options.removeAll - Remove container, git worktree, and branch
 * @param options.removeContainer - Remove only the Docker container
 * @param options.removeGitWorktreeAndBranch - Remove git worktree and branch
 */
const stopCommand = async (
  taskId: string,
  options: {
    json?: boolean;
    removeAll?: boolean;
    removeContainer?: boolean;
    removeGitWorktreeAndBranch?: boolean;
  } = {}
) => {
  if (options.json !== undefined) {
    setJsonMode(options.json);
  }

  const telemetry = getTelemetry();

  // Track stop task event
  telemetry?.eventStopTask();

  const json = options.json === true;
  let jsonOutput: TaskStopOutput = {
    success: false,
  };
  let stopWarning: string | undefined;

  const processManager = json
    ? undefined
    : new ProcessManager({ title: 'Stop task' });
  processManager?.start();

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

    processManager?.addItem(`Stopping Task`);

    // Stop sandbox container if it exists and is running
    if (task.containerId) {
      const sandbox = await createSandbox(task, processManager, {
        projectPath: project.path,
        sandboxMetadata: task.sandboxMetadata,
      });

      await sandbox.stopAndRemove();
    } else if (task.sandboxMetadata) {
      try {
        const sandbox = await createSandbox(task, processManager, {
          projectPath: project.path,
          sandboxMetadata: task.sandboxMetadata,
        });

        await sandbox.teardownServices();
      } catch (error) {
        if (!isSandboxBackendUnavailableError(error)) {
          throw error;
        }

        stopWarning =
          'Skipped sandbox service cleanup because no container backend is available. Task metadata was preserved so cleanup can be retried later.';
        if (!isJsonMode()) {
          console.warn(colors.yellow(`Warning: ${stopWarning}`));
        }
      }
    }

    processManager?.completeLastItem();

    // Reset task status to NEW and clear container info
    task.resetToNew();
    task.setContainerInfo(
      '',
      '',
      stopWarning ? task.sandboxMetadata : undefined
    );

    const shouldRemoveWorkspace =
      options.removeAll || options.removeGitWorktreeAndBranch;

    // Clean up Git worktree and branch when explicitly requested
    try {
      // Check if we're in a git repository
      await launch('git', ['rev-parse', '--is-inside-work-tree'], {
        stdio: 'pipe',
      });

      // Remove git workspace if it exists
      if (task.worktreePath && shouldRemoveWorkspace) {
        try {
          await launch(
            'git',
            ['worktree', 'remove', task.worktreePath, '--force'],
            { stdio: 'pipe' }
          );
        } catch (error) {
          // If workspace removal fails, try to remove it manually
          try {
            rmSync(task.worktreePath, { recursive: true, force: true });
            // Remove worktree from git's tracking
            await launch('git', ['worktree', 'prune'], { stdio: 'pipe' });
          } catch (manualError) {
            if (!isJsonMode()) {
              console.warn(
                colors.yellow('Warning: Could not remove workspace directory')
              );
            }
          }
        }
      }

      // Remove git branch if it exists
      if (task.branchName && shouldRemoveWorkspace) {
        try {
          // Check if branch exists
          await launch(
            'git',
            [
              'show-ref',
              '--verify',
              '--quiet',
              `refs/heads/${task.branchName}`,
            ],
            { stdio: 'pipe' }
          );
          // Delete the branch
          await launch('git', ['branch', '-D', task.branchName], {
            stdio: 'pipe',
          });
        } catch (error) {
          // Branch doesn't exist or couldn't be deleted, which is fine
        }
      }
    } catch (error) {
      // Not in a git repository, skip git operations
    }

    if (shouldRemoveWorkspace) {
      task.setWorkspace('', '');
    }

    jsonOutput = {
      ...jsonOutput,
      success: stopWarning === undefined,
      taskId: task.id,
      title: task.title,
      status: task.status,
      stoppedAt: new Date().toISOString(),
    };
    if (stopWarning) {
      jsonOutput.error = stopWarning;
      await exitWithWarn('Task stopped with warnings', jsonOutput, {
        tips: [
          'Use ' +
            colors.cyan(`rover stop ${task.id}`) +
            ' to retry sandbox cleanup',
          'Use ' +
            colors.cyan(`rover delete ${task.id}`) +
            ' to delete and clean up the task',
        ],
        telemetry,
      });
      return;
    }

    await exitWithSuccess('Task stopped successfully!', jsonOutput, {
      tips: [
        'Use ' + colors.cyan(`rover logs ${task.id}`) + ' to check the logs',
        'Use ' +
          colors.cyan(`rover restart ${task.id}`) +
          ' to restart the task',
        'Use ' +
          colors.cyan(`rover delete ${task.id}`) +
          ' to delete and clean up the task',
      ],
      telemetry,
    });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      jsonOutput.error = `The task with ID ${numericTaskId} was not found`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    } else {
      jsonOutput.error = `There was an error stopping the task: ${error}`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }
  } finally {
    await telemetry?.shutdown();
  }
};

// Named export for backwards compatibility (used by tests)
export { stopCommand };

export default {
  name: 'stop',
  description: 'Stop a running task and clean up its resources',
  requireProject: true,
  action: stopCommand,
} satisfies CommandDefinition;
