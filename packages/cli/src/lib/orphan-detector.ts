import { join } from 'node:path';
import colors from 'ansi-colors';
import type { ProjectManager, TaskDescriptionManager } from 'rover-core';
import { AGENT_EXIT_CODE } from 'rover-schemas';
import { isResumeLockActive } from '../utils/resume-lock.js';
import { createSandbox } from './sandbox/index.js';

function isResumeLockHeld(task: TaskDescriptionManager): boolean {
  const iterationPath = join(task.iterationsPath(), task.iterations.toString());
  return isResumeLockActive(iterationPath);
}

function hasContainerId(task: TaskDescriptionManager): boolean {
  return Boolean(task.containerId);
}

/** Maximum time (ms) to consider a restart "in flight" before treating it as stale.
 *  NOTE: This is intentionally shorter than LOCK_STALENESS_TIMEOUT_MS (30 min)
 *  in resume-lock.ts. If a startup exceeds this timeout, the orphan detector
 *  marks the task FAILED so it becomes resumable again. The resume lock may
 *  still be held until its own staleness timeout, but acquireResumeLock()
 *  reclaims stale locks from dead processes, so the gap is harmless. */
export const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Error message for containers that exited unexpectedly. */
export const CONTAINER_EXITED_ERROR =
  'Container exited unexpectedly (possible crash or system restart)';

function isRestartStartupInFlight(task: TaskDescriptionManager): boolean {
  // Use the most recent of lastRestartAt and lastResumedAt.
  const lastStartedAt = [task.lastRestartAt, task.lastResumedAt]
    .filter(Boolean)
    .sort()
    .pop();
  if (!lastStartedAt) return false;

  // If runningAt was updated after the last restart/resume, startup completed.
  if (
    task.runningAt &&
    new Date(task.runningAt).getTime() >= new Date(lastStartedAt).getTime()
  ) {
    return false;
  }

  // No runningAt (or stale runningAt) — startup hasn't completed.
  // Apply a timeout guard so a crashed restart doesn't permanently
  // prevent orphan detection for this task.
  return Date.now() - new Date(lastStartedAt).getTime() < STARTUP_TIMEOUT_MS;
}

/**
 * Detect tasks stuck as IN_PROGRESS or ITERATING whose container is no longer
 * running (e.g. after a crash or power-cycle) and transition them to FAILED so
 * that `rover resume` can recover them with checkpoint data intact.
 */
export async function detectOrphanedTasks(
  tasks: Array<{
    task: TaskDescriptionManager;
    project: ProjectManager | null;
  }>,
  options: { suppressWarnings?: boolean } = {}
): Promise<void> {
  const warn = options.suppressWarnings
    ? () => {}
    : (message: string) => {
        console.warn(message);
      };

  // Tasks we can reconcile either by inspecting a known container or by
  // timing out a restart/resume that never recorded replacement metadata.
  const candidates = tasks.filter(
    ({ task, project }) =>
      (task.isInProgress() || task.isIterating()) &&
      project != null &&
      !isResumeLockHeld(task) &&
      !isRestartStartupInFlight(task) &&
      (hasContainerId(task) ||
        task.lastRestartAt != null ||
        task.lastResumedAt != null)
  );

  if (candidates.length === 0) return;

  const results = await Promise.allSettled(
    candidates.map(async ({ task, project }) => {
      try {
        if (!hasContainerId(task)) {
          task.markFailed(
            'Task startup did not complete before container metadata was recorded'
          );
          warn(
            colors.yellow(
              `⚠ Task ${task.id} marked as FAILED — startup did not complete. Use "rover resume ${task.id}" to continue.`
            )
          );
          return;
        }

        // Full createSandbox is needed (rather than a lighter Docker inspect)
        // because the sandbox type is determined at runtime and may vary per task.
        const sandbox = await createSandbox(task, undefined, {
          projectPath: project?.path ?? '',
        });

        // Re-check lock after sandbox creation — another process may have
        // acquired the resume lock and started a new container between the
        // initial filter and here (TOCTOU window).
        if (isResumeLockHeld(task)) {
          return;
        }

        const state = await sandbox.inspect();

        // Re-check lock after inspect — another process may have acquired
        // the resume lock and started a new container during the inspect call.
        if (isResumeLockHeld(task)) {
          return;
        }

        if (!state) {
          // Final lock re-check after inspect returned null — another
          // process may have acquired the lock and started a replacement
          // container between inspect() returning and this check.
          if (isResumeLockHeld(task)) {
            return;
          }
          task.markFailed(CONTAINER_EXITED_ERROR);
          warn(
            colors.yellow(
              `⚠ Task ${task.id} marked as FAILED — container is no longer running. Use "rover resume ${task.id}" to continue.`
            )
          );
          return;
        }

        const containerStatus = (state.status ?? '').toLowerCase();
        if (
          containerStatus === 'running' ||
          containerStatus === 'created' ||
          containerStatus === 'restarting' ||
          containerStatus === 'paused'
        ) {
          return;
        }

        // Container exited — check exit code to distinguish clean exit from crash.
        // Exit code 0 means the workflow completed normally; the iteration status
        // file should already reflect this, so just refresh from disk.
        if (state.exitCode === AGENT_EXIT_CODE.SUCCESS) {
          task.updateStatusFromIteration();
          // If status is already terminal after refresh, nothing more to do.
          if (task.isCompleted() || task.isFailed() || task.isPaused()) {
            return;
          }
          // Exit code 0 is a clean exit — if the status file wasn't updated yet
          // (e.g., write still being flushed), force COMPLETED rather than
          // leaving the task in an active status with no running container.
          task.markCompleted();
          return;
        }

        // Exit code 2 means the agent paused (e.g. credit exhaustion).
        // The iteration status file should already say "paused", so read it.
        if (state.exitCode === AGENT_EXIT_CODE.PAUSED) {
          task.updateStatusFromIteration();
          if (task.isPaused() || task.isFailed()) {
            return;
          }
          // Status file wasn't written yet; mark PAUSED rather than FAILED
          // so the task is eligible for `rover resume` without manual intervention.
          task.markPaused(
            'Workflow paused due to retryable error (e.g. credit limit)'
          );
          return;
        }

        // Try to read the agent's last error from the status file before
        // falling back to a generic message.
        task.updateStatusFromIteration();
        if (!task.isFailed()) {
          task.markFailed(CONTAINER_EXITED_ERROR);
        }
        warn(
          colors.yellow(
            `⚠ Task ${task.id} marked as FAILED — container is no longer running. Use "rover resume ${task.id}" to continue.`
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(
          colors.yellow(
            `⚠ Could not inspect container for task ${task.id}, skipping orphan check: ${msg}`
          )
        );
      }
    })
  );

  // Log any unexpected rejections that escaped the per-task try/catch.
  // Always log these — they indicate a bug in the per-task error handling.
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(
        colors.yellow(
          `⚠ Unexpected error during orphan detection: ${result.reason}`
        )
      );
    }
  }
}
