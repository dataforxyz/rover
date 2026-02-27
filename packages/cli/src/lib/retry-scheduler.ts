import type { ProjectManager } from 'rover-core';
import { resumeTask } from './resume-helper.js';
import colors from 'ansi-colors';

/**
 * Calculate the next retry time: top of the next hour + random 2-10 min jitter.
 * Exported for testing.
 */
export function calculateNextRetryTime(now: Date = new Date()): Date {
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1);

  // Add random jitter between 2-10 minutes
  const jitterMinutes = 2 + Math.random() * 8;
  nextHour.setUTCMinutes(nextHour.getUTCMinutes() + Math.floor(jitterMinutes));
  nextHour.setUTCSeconds(Math.floor(Math.random() * 60));

  return nextHour;
}

interface ProviderTimerEntry {
  timer: NodeJS.Timeout;
  scheduledAt: Date;
  taskEntries: Map<number, { project: ProjectManager }>;
}

/**
 * Per-provider timer that auto-resumes paused tasks at the next hour boundary
 * + random 2-10 minute jitter. Designed to handle credit exhaustion recovery
 * where credits reset on the hour.
 */
export class RetryScheduler {
  private providerTimers: Map<string, ProviderTimerEntry> = new Map();

  /**
   * Register a paused task for automatic retry.
   * If no timer exists for this provider, one is scheduled for the next hour + jitter.
   * If a timer already exists, the task is added to the existing provider group.
   */
  registerPausedTask(
    provider: string,
    taskId: number,
    project: ProjectManager
  ): void {
    const existing = this.providerTimers.get(provider);

    if (existing) {
      // Timer already exists - just add the task
      existing.taskEntries.set(taskId, { project });
      return;
    }

    // Create a new timer for this provider
    const scheduledAt = calculateNextRetryTime();
    const delayMs = scheduledAt.getTime() - Date.now();

    const taskEntries = new Map<number, { project: ProjectManager }>();
    taskEntries.set(taskId, { project });

    const timer = setTimeout(() => this.fireRetry(provider), delayMs);
    // Unref so this timer doesn't keep the process alive
    timer.unref();

    this.providerTimers.set(provider, {
      timer,
      scheduledAt,
      taskEntries,
    });

    console.log(
      colors.gray(
        `  ⏱ Auto-retry scheduled for ${provider} tasks at ${scheduledAt.toLocaleTimeString()}`
      )
    );
  }

  /**
   * Remove a task from the retry schedule (e.g., manually resumed).
   * If no tasks remain for the provider, the timer is cleared.
   */
  unregisterTask(provider: string, taskId: number): void {
    const entry = this.providerTimers.get(provider);
    if (!entry) return;

    entry.taskEntries.delete(taskId);

    if (entry.taskEntries.size === 0) {
      clearTimeout(entry.timer);
      this.providerTimers.delete(provider);
    }
  }

  /**
   * Get the scheduled retry time for a provider.
   */
  getScheduledTime(provider: string): Date | undefined {
    return this.providerTimers.get(provider)?.scheduledAt;
  }

  /**
   * Clean up all timers. Call on SIGINT / process exit.
   */
  destroy(): void {
    for (const entry of this.providerTimers.values()) {
      clearTimeout(entry.timer);
    }
    this.providerTimers.clear();
  }

  /**
   * Internal: fires when a provider's timer expires.
   * Attempts to resume all tasks for that provider.
   */
  private async fireRetry(provider: string): Promise<void> {
    const entry = this.providerTimers.get(provider);
    if (!entry) return;

    // Take a snapshot of tasks and clear the timer entry
    const tasks = new Map(entry.taskEntries);
    this.providerTimers.delete(provider);

    console.log(
      colors.cyan(
        `\n🔄 Auto-retrying ${tasks.size} paused ${provider} task(s)...`
      )
    );

    for (const [taskId, { project }] of tasks) {
      try {
        const success = await resumeTask(project, taskId);
        if (success) {
          console.log(colors.green(`  ✓ Task ${taskId} resumed successfully`));
        } else {
          console.log(
            colors.yellow(
              `  ⚠ Task ${taskId} could not be resumed, re-scheduling...`
            )
          );
          // Re-register for the next hour
          this.registerPausedTask(provider, taskId, project);
        }
      } catch (error) {
        console.log(
          colors.yellow(
            `  ⚠ Task ${taskId} resume failed: ${error instanceof Error ? error.message : String(error)}, re-scheduling...`
          )
        );
        // Re-register for the next hour
        this.registerPausedTask(provider, taskId, project);
      }
    }
  }
}
