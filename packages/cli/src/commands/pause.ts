import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import colors from 'ansi-colors';
import { ProcessManager } from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import {
  isJsonMode,
  requireProjectContext,
  setJsonMode,
} from '../lib/context.js';
import { createSandbox } from '../lib/sandbox/index.js';
import { getTelemetry } from '../lib/telemetry.js';
import type { TaskPauseOutput } from '../output-types.js';
import type { CommandDefinition } from '../types.js';
import { exitWithError, exitWithSuccess } from '../utils/exit.js';

/**
 * Maximum time (ms) to wait for the agent to finish its current step
 * and exit after seeing the pause-requested signal file.  Steps can
 * take a while (AI calls, test runs), so this is generous.
 */
const GRACEFUL_WAIT_MS = 600_000; // 10 minutes
const POLL_MS = 1_000;

/**
 * If the agent hasn't exited after GRACEFUL_WAIT_MS, fall back to
 * SIGTERM via `docker stop`.  The agent's SIGTERM handler still saves
 * a checkpoint, but it interrupts the current step.
 */
const SIGTERM_WAIT_MS = 30_000; // 30 seconds for SIGTERM to take effect

/**
 * Gracefully pause a running task.
 *
 * Writes a `.pause-requested` signal file into the iteration directory.
 * The agent checks for this file between steps and exits cleanly with
 * code 2 (PAUSED) after finishing its current step.
 *
 * If the agent doesn't exit within the timeout, falls back to SIGTERM.
 *
 * Unlike `rover stop`, this preserves the worktree, branch, and all
 * iteration data so the task can continue with `rover resume`.
 */
const pauseCommand = async (
  taskId: string,
  options: {
    json?: boolean;
    reason?: string;
  } = {}
) => {
  if (options.json !== undefined) {
    setJsonMode(options.json);
  }

  const telemetry = getTelemetry();

  const json = options.json === true;
  let jsonOutput: TaskPauseOutput = {
    success: false,
  };

  const processManager = json
    ? undefined
    : new ProcessManager({ title: 'Pause task' });
  processManager?.start();

  if (!/^\d+$/.test(taskId)) {
    jsonOutput.error = `Invalid task ID '${taskId}' - must be a number`;
    await exitWithError(jsonOutput, { telemetry });
    return;
  }
  const numericTaskId = parseInt(taskId, 10);

  let project;
  try {
    project = await requireProjectContext();
  } catch (error) {
    jsonOutput.error = error instanceof Error ? error.message : String(error);
    await exitWithError(jsonOutput, { telemetry });
    return;
  }

  try {
    const task = project.getTask(numericTaskId);
    if (!task) {
      throw new TaskNotFoundError(numericTaskId);
    }

    // Only running tasks can be paused
    if (!task.isInProgress() && !task.isIterating()) {
      jsonOutput.error = `Task ${numericTaskId} is not running (status: ${task.status}). Only IN_PROGRESS or ITERATING tasks can be paused.`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    if (task.isPaused()) {
      jsonOutput.error = `Task ${numericTaskId} is already paused`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    const reason = options.reason || 'Paused by user via rover pause';

    // Write the pause-requested signal file into the iteration directory.
    // The agent checks for this between steps and exits cleanly.
    const iterationPath = join(
      task.iterationsPath(),
      task.iterations.toString()
    );
    const pauseRequestFile = join(iterationPath, '.pause-requested');
    const checkpointPath = join(iterationPath, 'checkpoint.json');

    processManager?.addItem(
      'Requesting graceful pause (waiting for current step to finish)'
    );

    writeFileSync(pauseRequestFile, reason, 'utf-8');

    // Wait for the agent to finish its current step and exit.
    // We detect this by watching for the task status to change or
    // the container to exit.
    let agentExited = false;
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    if (task.containerId) {
      sandbox = await createSandbox(task, undefined, {
        projectPath: project.path,
        sandboxMetadata: task.sandboxMetadata,
      });

      const deadline = Date.now() + GRACEFUL_WAIT_MS;
      while (Date.now() < deadline) {
        const state = await sandbox.inspect();
        if (!state || state.status === 'exited' || state.status === '') {
          agentExited = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }

      if (agentExited) {
        await sandbox.teardownServices();
      }

      // If the agent is still running, fall back to SIGTERM
      if (!agentExited) {
        if (!isJsonMode()) {
          console.log(
            colors.yellow(
              '  Agent did not exit within timeout — sending SIGTERM'
            )
          );
        }
        await sandbox.stopGracefully();

        // Give it a moment to write the checkpoint
        const sigtermDeadline = Date.now() + SIGTERM_WAIT_MS;
        while (Date.now() < sigtermDeadline) {
          const state = await sandbox.inspect();
          if (!state || state.status === 'exited' || state.status === '') {
            agentExited = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
      }
    } else {
      // No container — task might have already exited
      agentExited = true;
    }

    processManager?.completeLastItem();

    if (!agentExited) {
      jsonOutput.error = `Task ${numericTaskId} did not exit after pause request and SIGTERM; task is still running`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    const hasCheckpoint = existsSync(checkpointPath);
    const sandboxMetadata =
      typeof sandbox?.getSandboxMetadata === 'function'
        ? sandbox.getSandboxMetadata()
        : task.sandboxMetadata;

    // Mark the task as PAUSED and clear the task container identity while
    // preserving any sandbox metadata still needed for resume.
    task.markPaused(reason);
    task.setContainerInfo('', '', sandboxMetadata);

    if (!isJsonMode()) {
      if (hasCheckpoint) {
        console.log(
          colors.green(
            '  Checkpoint saved — task can be resumed from where it left off'
          )
        );
      } else {
        console.log(
          colors.yellow(
            '  No checkpoint detected — resume will restart the current iteration'
          )
        );
      }
    }

    jsonOutput = {
      ...jsonOutput,
      success: true,
      taskId: task.id,
      title: task.title,
      status: task.status,
      pausedAt: new Date().toISOString(),
      reason,
      hasCheckpoint,
    };
    await exitWithSuccess('Task paused successfully!', jsonOutput, {
      tips: [
        'Use ' +
          colors.cyan(`rover resume ${task.id}`) +
          ' to continue from checkpoint',
        'Use ' + colors.cyan(`rover logs ${task.id}`) + ' to check the logs',
        'Use ' +
          colors.cyan(`rover inspect ${task.id}`) +
          ' to see task details',
      ],
      telemetry,
    });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      jsonOutput.error = `The task with ID ${numericTaskId} was not found`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    } else {
      jsonOutput.error = `There was an error pausing the task: ${error}`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }
  } finally {
    await telemetry?.shutdown();
  }
};

export { pauseCommand };

export default {
  name: 'pause',
  description:
    'Gracefully pause a running task (preserves checkpoint for resume)',
  requireProject: true,
  action: pauseCommand,
} satisfies CommandDefinition;
