import type { ProjectManager } from 'rover-core';
import { resumeTask } from './resume-helper.js';
import { checkClaudeUsage, invalidateUsageCache } from './claude-usage.js';
import { checkCodexUsage, invalidateCodexUsageCache } from './codex-usage.js';
import colors from 'ansi-colors';

/**
 * Calculate the next hourly retry window with attempt-based backoff.
 * `attempt` is the number of previous failures (0 = first try).
 *
 * The window is computed by snapping to the current hour boundary, then
 * advancing by 1h, 2h, 4h, 8h, 16h (capped at 24h), plus 2-10 min jitter.
 * This means the first retry may fire much sooner than 1 hour if the pause
 * happened late in the hour (e.g., paused at 14:59 → retry at ~15:02).
 *
 * Exported for testing.
 */
export function calculateNextRetryWindow(
  now: Date = new Date(),
  attempt: number = 0,
  random: () => number = Math.random
): Date {
  const hoursToWait = Math.min(Math.pow(2, attempt), 24);
  const nextTime = new Date(now);
  nextTime.setUTCMinutes(0, 0, 0);
  // setUTCHours handles overflow (e.g. 25 → 1 AM next day) per the JS Date spec
  nextTime.setUTCHours(nextTime.getUTCHours() + hoursToWait);

  // Add random jitter between 2-10 minutes
  const jitterMinutes = 2 + random() * 8;
  nextTime.setUTCMinutes(nextTime.getUTCMinutes() + Math.floor(jitterMinutes));
  nextTime.setUTCSeconds(Math.floor(random() * 60));

  return nextTime;
}

/**
 * Maximum number of automatic retry cycles per task before giving up.
 * After this many failed resume attempts the task stays PAUSED and the
 * user must manually `rover resume <id>`.
 */
export const MAX_AUTO_RETRIES = 5;

interface TaskTimerEntry {
  provider: string;
  taskId: number;
  project: ProjectManager;
  timer: NodeJS.Timeout;
  scheduledAt: Date;
}

/**
 * Per-task timers grouped by provider for display. Each paused task keeps its
 * own retry schedule so one task's backoff window does not delay or accelerate
 * another task from the same provider.
 *
 * NOTE: Auto-retry is only active while `rover list --watch` is running.
 * If the terminal session ends, scheduled retries are lost. Users can always
 * manually resume with `rover resume <taskId>`.
 */
export class RetryScheduler {
  private taskTimers: Map<string, TaskTimerEntry> = new Map();
  /** Tracks how many retry cycles each task has gone through. */
  private retryCounts: Map<string, number> = new Map();
  /** Remembers which provider owns each retry count entry. */
  private retryProviders: Map<string, string> = new Map();
  /** When true, suppress informational console.log messages (e.g. JSON mode). */
  private quiet: boolean;

  constructor(options: { quiet?: boolean } = {}) {
    this.quiet = options.quiet ?? false;
  }

  private log(...args: unknown[]): void {
    if (!this.quiet) {
      console.log(...args);
    }
  }

  /** Separator that won't appear in file paths or numeric task IDs. */
  private static readonly KEY_SEP = '\0';

  private taskKey(project: ProjectManager, taskId: number): string {
    return `${project.path}${RetryScheduler.KEY_SEP}${taskId}`;
  }

  private clearTimer(taskKey: string): void {
    const entry = this.taskTimers.get(taskKey);
    if (entry) {
      clearTimeout(entry.timer);
      this.taskTimers.delete(taskKey);
    }
  }

  private clearTaskState(taskKey: string): void {
    this.clearTimer(taskKey);
    this.retryCounts.delete(taskKey);
    this.retryProviders.delete(taskKey);
  }

  /**
   * Register a paused task for automatic retry.
   * Each task gets its own timer based on its own retry count.
   *
   * For Claude tasks, queries the usage API to schedule smarter retries:
   * - If exhausted → schedule at `resets_at + jitter` instead of blind backoff
   * - If NOT exhausted → use a conservative 5-minute delay
   * - If check fails → fall through to existing blind backoff
   */
  async registerPausedTask(
    provider: string,
    taskId: number,
    project: ProjectManager
  ): Promise<void> {
    const key = this.taskKey(project, taskId);

    const existing = this.taskTimers.get(key);
    if (existing) {
      if (existing.provider === provider) {
        return;
      }

      // Provider changed — reset state so the new provider gets a fresh
      // retry budget (different provider = different credit pool).
      this.clearTaskState(key);
    }

    this.retryProviders.set(key, provider);

    // Seed retry count from persisted auto-retry state if we haven't tracked
    // this task yet. Manual resumes/restarts maintain a separate restartCount.
    if (!this.retryCounts.has(key)) {
      try {
        const task = project.getTask(taskId);
        const autoRetryCount = task?.autoRetryCount ?? 0;
        if (autoRetryCount > 0) {
          this.retryCounts.set(key, autoRetryCount);
        }
      } catch {
        // Task may have been deleted between list and register
      }
    }

    const retryCount = this.retryCounts.get(key) ?? 0;
    if (retryCount >= MAX_AUTO_RETRIES) {
      this.log(
        colors.yellow(
          `  ⚠ Task ${taskId} reached max auto-retries (${MAX_AUTO_RETRIES}), use ${colors.cyan(`rover resume ${taskId}`)} to retry manually.`
        )
      );
      return;
    }

    // Compute blind backoff as default
    const blindScheduledAt = calculateNextRetryWindow(new Date(), retryCount);
    let scheduledAt = blindScheduledAt;

    // Smart scheduling: query usage API to avoid wasting retry attempts
    const usageSmartSchedule = await this.queryUsageForScheduling(
      provider,
      project,
      taskId,
      blindScheduledAt
    );
    if (usageSmartSchedule) {
      scheduledAt = usageSmartSchedule;
    }

    const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      void this.fireRetry(key).catch(err => {
        console.warn(
          `Retry failed for ${key}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, delayMs);
    timer.unref();

    this.taskTimers.set(key, {
      provider,
      taskId,
      project,
      timer,
      scheduledAt,
    });

    this.log(
      colors.gray(
        `  ⏱ Auto-retry scheduled for ${provider} task ${taskId} at ${scheduledAt.toLocaleTimeString()}`
      )
    );
  }

  /**
   * Remove a task from the retry schedule (e.g., manually resumed).
   */
  unregisterTask(
    provider: string,
    taskId: number,
    project?: ProjectManager
  ): void {
    if (project) {
      this.clearTaskState(this.taskKey(project, taskId));
      return;
    }

    // Without a project, clear both timer and retry counts for matching
    // entries. This prevents memory leaks from accumulating entries.
    // Also scan retryCounts directly in case the timer was already removed
    // (e.g. after max retries) — the retry count key uses the same format.
    for (const [key, entry] of this.taskTimers.entries()) {
      if (entry.provider === provider && entry.taskId === taskId) {
        this.clearTaskState(key);
      }
    }
    // Clean up orphaned retry counts whose timers were already removed
    for (const key of this.retryCounts.keys()) {
      if (
        key.endsWith(`${RetryScheduler.KEY_SEP}${taskId}`) &&
        this.retryProviders.get(key) === provider
      ) {
        this.retryCounts.delete(key);
        this.retryProviders.delete(key);
      }
    }
  }

  /**
   * Get the next scheduled retry time for a provider.
   */
  getScheduledTime(provider: string): Date | undefined {
    let earliest: Date | undefined;

    for (const entry of this.taskTimers.values()) {
      if (entry.provider !== provider) continue;
      if (!earliest || entry.scheduledAt.getTime() < earliest.getTime()) {
        earliest = entry.scheduledAt;
      }
    }

    return earliest;
  }

  /**
   * Get the next scheduled retry time for a specific paused task.
   */
  getScheduledTimeForTask(
    project: ProjectManager,
    taskId: number
  ): Date | undefined {
    const entry = this.taskTimers.get(this.taskKey(project, taskId));
    return entry?.scheduledAt;
  }

  /**
   * Get the number of retry attempts for a task.
   */
  getRetryCount(project: ProjectManager, taskId: number): number {
    return this.retryCounts.get(this.taskKey(project, taskId)) ?? 0;
  }

  /**
   * Clean up all timers. Call on SIGINT / process exit.
   */
  destroy(): void {
    for (const entry of this.taskTimers.values()) {
      clearTimeout(entry.timer);
    }
    this.taskTimers.clear();
    this.retryCounts.clear();
    this.retryProviders.clear();
  }

  /**
   * Query the usage API and return a smarter schedule time, or null to
   * fall through to blind backoff.  Works for both Claude and Codex.
   */
  private async queryUsageForScheduling(
    provider: string,
    project: ProjectManager,
    taskId: number,
    blindScheduledAt: Date
  ): Promise<Date | null> {
    const prov = provider.toLowerCase();
    if (prov !== 'claude' && prov !== 'codex') return null;

    try {
      const taskModel = project.getTask(taskId)?.agentModel;

      const usageResult =
        prov === 'claude'
          ? await checkClaudeUsage(taskModel)
          : await checkCodexUsage(taskModel);

      if (!usageResult) return null;

      if (usageResult.isExhausted && usageResult.resetsAt) {
        const jitterMs = (2 + Math.random() * 3) * 60 * 1000;
        const resetBased = new Date(usageResult.resetsAt.getTime() + jitterMs);
        if (
          resetBased.getTime() > Date.now() &&
          (resetBased.getTime() < blindScheduledAt.getTime() ||
            blindScheduledAt.getTime() < usageResult.resetsAt.getTime())
        ) {
          this.log(
            colors.gray(
              `  📊 ${provider} usage exhausted (${usageResult.limitingBucket} ${Math.round(usageResult.utilization)}%), scheduling after reset`
            )
          );
          return resetBased;
        }
      } else {
        // Not exhausted — credits may have restored since the pause.
        const shortDelay = new Date(Date.now() + 5 * 60 * 1000);
        this.log(
          colors.gray(
            `  📊 ${provider} usage available (${Math.round(usageResult.utilization)}%), retrying in 5 minutes`
          )
        );
        return shortDelay;
      }
    } catch {
      // Usage check failed — fall through to blind backoff
    }

    return null;
  }

  /**
   * Pre-fire usage check: if still exhausted, defer the retry without
   * burning a retry attempt.  Returns true if the retry was deferred.
   */
  private async preFireUsageCheck(
    provider: string,
    task: any,
    taskKey: string,
    taskId: number,
    project: ProjectManager
  ): Promise<boolean> {
    const prov = provider.toLowerCase();
    if (prov !== 'claude' && prov !== 'codex') return false;

    try {
      // Invalidate caches so we get fresh data
      if (prov === 'claude') invalidateUsageCache();
      else invalidateCodexUsageCache();

      const taskModel = task?.agentModel;
      const usageResult =
        prov === 'claude'
          ? await checkClaudeUsage(taskModel)
          : await checkCodexUsage(taskModel);

      if (usageResult?.isExhausted && usageResult.resetsAt) {
        const jitterMs = (2 + Math.random() * 3) * 60 * 1000;
        const deferUntil = new Date(usageResult.resetsAt.getTime() + jitterMs);
        if (deferUntil.getTime() > Date.now()) {
          this.log(
            colors.yellow(
              `  ⏳ ${provider} usage still exhausted (${usageResult.limitingBucket}), deferring task ${taskId} to ${deferUntil.toLocaleTimeString()} without counting as retry`
            )
          );

          const deferMs = deferUntil.getTime() - Date.now();
          const deferTimer = setTimeout(() => {
            void this.fireRetry(taskKey).catch(err => {
              console.warn(
                `Retry failed for ${taskKey}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }, deferMs);
          deferTimer.unref();

          this.taskTimers.set(taskKey, {
            provider,
            taskId,
            project,
            timer: deferTimer,
            scheduledAt: deferUntil,
          });
          return true;
        }
      }
    } catch {
      // Usage check failed — proceed with normal resume
    }

    return false;
  }

  /**
   * Internal: fires when an individual task's timer expires.
   */
  private async fireRetry(taskKey: string): Promise<void> {
    const entry = this.taskTimers.get(taskKey);
    if (!entry) return;

    const { provider, taskId, project } = entry;
    // Clear the timer reference but keep the entry until the resume attempt
    // completes, so the task isn't lost from the scheduler on failure.
    clearTimeout(entry.timer);
    this.taskTimers.delete(taskKey);

    // Re-read task state to avoid firing a resume when the task was already
    // handled by another process before our timer fired.
    // NOTE: There is an inherent TOCTOU window between this check and the
    // resumeTask() call below — another process could resume the task in the
    // gap. This is acceptable because resumeTask() will return 'not_resumable'
    // or 'already_resuming', and we do not increment the retry count in those
    // cases.
    const task = project.getTask(taskId);
    if (!task || (!task.isPaused() && !task.isFailed())) {
      this.retryCounts.delete(taskKey);
      this.retryProviders.delete(taskKey);
      return;
    }

    // Pre-fire usage check: if still exhausted, defer without burning a retry.
    const deferResult = await this.preFireUsageCheck(
      provider,
      task,
      taskKey,
      taskId,
      project
    );
    if (deferResult) return;

    this.log(
      colors.cyan(`\n🔄 Auto-retrying paused ${provider} task ${taskId}...`)
    );

    const previousCount = this.retryCounts.get(taskKey) ?? 0;

    try {
      const result = await resumeTask(project, taskId, {
        quiet: this.quiet,
        preserveAutoRetryCount: true,
      });
      if (result.status === 'ok') {
        // Resume succeeded — reset the retry budget so future pauses
        // get the full retry allowance again.
        const resumedTask = project.getTask(taskId);
        resumedTask?.setAutoRetryCount(0);
        this.retryCounts.delete(taskKey);
        this.retryProviders.delete(taskKey);
        this.log(colors.green(`  ✓ Task ${taskId} resumed successfully`));
      } else if (result.status === 'already_resuming') {
        // Another process is handling it — don't count as a failure.
        this.log(
          colors.gray(
            `  ℹ Task ${taskId} is already being resumed by another process`
          )
        );
      } else if (result.status === 'not_resumable') {
        // Another process may have resumed or completed the task after we
        // re-read it but before we acquired the resume lock.
        this.log(
          colors.gray(
            `  ℹ Task ${taskId} is no longer resumable; stopping auto-retry`
          )
        );
        this.retryCounts.delete(taskKey);
        this.retryProviders.delete(taskKey);
      } else {
        // Resume returned a non-success status — count this as a failed attempt.
        const attempt = previousCount + 1;
        this.retryCounts.set(taskKey, attempt);
        if (attempt >= MAX_AUTO_RETRIES) {
          this.log(
            colors.red(
              `  ✗ Task ${taskId} failed to resume after ${attempt} attempts, giving up. Use ${colors.cyan(`rover resume ${taskId}`)} to retry manually.`
            )
          );
        } else {
          this.log(
            colors.yellow(
              `  ⚠ Task ${taskId} could not be resumed (attempt ${attempt}/${MAX_AUTO_RETRIES}), re-scheduling...`
            )
          );
          // Timer was already deleted and retry count incremented above, so
          // registerPausedTask will find no existing timer and will use the
          // current retry count for backoff.
          await this.registerPausedTask(provider, taskId, project);
        }
      }
    } catch (error) {
      // Resume threw — count this as a failed attempt.
      const attempt = previousCount + 1;
      this.retryCounts.set(taskKey, attempt);
      if (attempt >= MAX_AUTO_RETRIES) {
        this.log(
          colors.red(
            `  ✗ Task ${taskId} resume failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}. Use ${colors.cyan(`rover resume ${taskId}`)} to retry manually.`
          )
        );
      } else {
        this.log(
          colors.yellow(
            `  ⚠ Task ${taskId} resume failed (attempt ${attempt}/${MAX_AUTO_RETRIES}): ${error instanceof Error ? error.message : String(error)}, re-scheduling...`
          )
        );
        // Same invariant as the non-exception path above: timer cleared
        // and retry count incremented, so registerPausedTask computes
        // correct backoff.
        await this.registerPausedTask(provider, taskId, project);
      }
    }
  }
}
