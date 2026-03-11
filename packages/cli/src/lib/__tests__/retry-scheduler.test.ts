import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RetryScheduler,
  calculateNextRetryWindow,
  MAX_AUTO_RETRIES,
} from '../retry-scheduler.js';

// Mock the resume-helper module
vi.mock('../resume-helper.js', () => ({
  resumeTask: vi.fn(),
}));

// Mock the claude-usage module — returns null by default (no credentials),
// so existing blind-backoff tests remain unchanged.
vi.mock('../claude-usage.js', () => ({
  checkClaudeUsage: vi.fn().mockResolvedValue(null),
  invalidateUsageCache: vi.fn(),
}));

import { resumeTask } from '../resume-helper.js';
import { checkClaudeUsage, invalidateUsageCache } from '../claude-usage.js';

const mockedResumeTask = vi.mocked(resumeTask);
const mockedCheckClaudeUsage = vi.mocked(checkClaudeUsage);
const mockedInvalidateUsageCache = vi.mocked(invalidateUsageCache);

describe('RetryScheduler', () => {
  let scheduler: RetryScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T14:00:00.000Z'));
    scheduler = new RetryScheduler();
    mockedResumeTask.mockReset();
    mockedCheckClaudeUsage.mockReset().mockResolvedValue(null);
    mockedInvalidateUsageCache.mockReset();
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  describe('calculateNextRetryWindow', () => {
    it('returns a time in the next hourly window + 2-10 min jitter', () => {
      const now = new Date('2026-01-15T14:30:00.000Z');
      // Run multiple times to verify range
      for (let i = 0; i < 20; i++) {
        const result = calculateNextRetryWindow(now);
        // Should be in the 15:02-15:10 UTC range
        expect(result.getUTCHours()).toBe(15);
        expect(result.getUTCMinutes()).toBeGreaterThanOrEqual(2);
        expect(result.getUTCMinutes()).toBeLessThanOrEqual(10);
      }
    });

    it('wraps around midnight correctly', () => {
      const now = new Date('2026-01-15T23:45:00.000Z');
      const result = calculateNextRetryWindow(now);
      // Should be next day 00:02-00:10 UTC
      expect(result.getUTCDate()).toBe(16);
      expect(result.getUTCHours()).toBe(0);
      expect(result.getUTCMinutes()).toBeGreaterThanOrEqual(2);
      expect(result.getUTCMinutes()).toBeLessThanOrEqual(10);
    });

    it('moves the retry window forward for each attempt', () => {
      const now = new Date('2026-01-15T14:00:00.000Z');
      for (let i = 0; i < 20; i++) {
        // attempt 0: 1 hour → 15:02-15:10
        const r0 = calculateNextRetryWindow(now, 0);
        expect(r0.getUTCHours()).toBe(15);

        // attempt 1: 2 hours → 16:02-16:10
        const r1 = calculateNextRetryWindow(now, 1);
        expect(r1.getUTCHours()).toBe(16);

        // attempt 2: 4 hours → 18:02-18:10
        const r2 = calculateNextRetryWindow(now, 2);
        expect(r2.getUTCHours()).toBe(18);

        // attempt 3: 8 hours → 22:02-22:10
        const r3 = calculateNextRetryWindow(now, 3);
        expect(r3.getUTCHours()).toBe(22);

        // attempt 4: 16 hours → next day 06:02-06:10
        const r4 = calculateNextRetryWindow(now, 4);
        expect(r4.getUTCDate()).toBe(16);
        expect(r4.getUTCHours()).toBe(6);
      }
    });

    it('caps the retry window at 24 hours', () => {
      const now = new Date('2026-01-15T14:00:00.000Z');
      // attempt 10: 2^10 = 1024 hours, capped at 24
      const result = calculateNextRetryWindow(now, 10);
      const diffHours = (result.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThanOrEqual(24);
      expect(diffHours).toBeLessThanOrEqual(25);
    });

    it('snaps late-hour retries into the next hourly window instead of waiting a full hour', () => {
      const now = new Date('2026-01-15T14:59:00.000Z');
      const result = calculateNextRetryWindow(now, 0);

      expect(result.getUTCHours()).toBe(15);
      expect(result.getUTCMinutes()).toBeGreaterThanOrEqual(2);
      expect(result.getUTCMinutes()).toBeLessThanOrEqual(10);
    });
  });

  /** Helper to create a mock project with getTask returning a resumable task. */
  function makeMockProject(
    path = '/tmp/project',
    taskStatus = 'PAUSED',
    autoRetryCount = 0,
    restartCount = 0,
    agentModel?: string
  ): any {
    const task = {
      status: taskStatus,
      autoRetryCount,
      restartCount,
      agentModel,
      isPaused: () => taskStatus === 'PAUSED',
      isFailed: () => taskStatus === 'FAILED',
      setAutoRetryCount: vi.fn((count: number) => {
        task.autoRetryCount = count;
      }),
    };

    return {
      path,
      getTask: vi.fn().mockReturnValue(task),
    };
  }

  describe('registerPausedTask', () => {
    it('creates a new timer for a new provider', async () => {
      const mockProject = makeMockProject();
      await scheduler.registerPausedTask('claude', 1, mockProject);

      const scheduledTime = scheduler.getScheduledTime('claude');
      expect(scheduledTime).toBeDefined();
      expect(scheduledTime!.getTime()).toBeGreaterThan(Date.now());
    });

    it('updates the provider retry time when a newly added task is scheduled earlier', async () => {
      const mockProject = makeMockProject();
      const randomSpy = vi
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0.99)
        .mockReturnValueOnce(0.99)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0);

      await scheduler.registerPausedTask('claude', 1, mockProject);
      const firstScheduledTime = scheduler.getScheduledTime('claude');

      await scheduler.registerPausedTask('claude', 2, mockProject);
      const secondScheduledTime = scheduler.getScheduledTime('claude');

      expect(firstScheduledTime).toBeDefined();
      expect(secondScheduledTime).toBeDefined();
      expect(secondScheduledTime!.getTime()).toBeLessThan(
        firstScheduledTime!.getTime()
      );

      randomSpy.mockRestore();
    });

    it('creates separate timers for different providers', async () => {
      const mockProject = makeMockProject();
      await scheduler.registerPausedTask('claude', 1, mockProject);
      await scheduler.registerPausedTask('gemini', 2, mockProject);

      expect(scheduler.getScheduledTime('claude')).toBeDefined();
      expect(scheduler.getScheduledTime('gemini')).toBeDefined();
    });

    it('returns task-specific scheduled times for paused tasks', async () => {
      const mockProject = makeMockProject();
      await scheduler.registerPausedTask('claude', 1, mockProject);
      await scheduler.registerPausedTask('claude', 2, mockProject);

      expect(scheduler.getScheduledTimeForTask(mockProject, 1)).toBeDefined();
      expect(scheduler.getScheduledTimeForTask(mockProject, 2)).toBeDefined();
      expect(
        scheduler.getScheduledTimeForTask(mockProject, 999)
      ).toBeUndefined();
    });

    it('correctly tracks tasks from projects with colons in path', async () => {
      const projectA = makeMockProject('/tmp/C:/Users/projectA');
      const projectB = makeMockProject('/home/user:name/project:B');

      await scheduler.registerPausedTask('claude', 1, projectA);
      await scheduler.registerPausedTask('claude', 2, projectB);

      expect(scheduler.getRetryCount(projectA, 1)).toBe(0);
      expect(scheduler.getRetryCount(projectB, 2)).toBe(0);
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('resets retry backoff immediately when provider changes', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);
      await vi.advanceTimersToNextTimerAsync();

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(1);

      await scheduler.registerPausedTask('gemini', 1, mockProject);

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
      const scheduled = scheduler.getScheduledTime('gemini');
      expect(scheduled).toBeDefined();
      // Attempt 0 should schedule in the next hour window, not attempt 1 (+2h).
      expect(scheduled!.getUTCHours()).toBe(16);
    });

    it('does not consume auto-retry budget from manual restart history', async () => {
      const mockProject = makeMockProject(
        '/tmp/project',
        'PAUSED',
        0,
        MAX_AUTO_RETRIES
      );

      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
      expect(scheduler.getScheduledTimeForTask(mockProject, 1)).toBeDefined();
    });

    it('restores persisted auto-retry count across watcher restarts', async () => {
      const mockProject = makeMockProject('/tmp/project', 'PAUSED', 3, 0);

      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(3);
      const scheduled = scheduler.getScheduledTimeForTask(mockProject, 1);
      expect(scheduled).toBeDefined();
      expect(scheduled!.getUTCHours()).toBe(22);
    });
  });

  describe('unregisterTask', () => {
    it('removes a task from the provider group', async () => {
      const mockProject = makeMockProject();
      await scheduler.registerPausedTask('claude', 1, mockProject);
      await scheduler.registerPausedTask('claude', 2, mockProject);

      scheduler.unregisterTask('claude', 1, mockProject);

      // Timer should still exist (task 2 remains)
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('clears timer when last task for provider is removed', async () => {
      const mockProject = makeMockProject();
      await scheduler.registerPausedTask('claude', 1, mockProject);

      scheduler.unregisterTask('claude', 1, mockProject);

      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('handles unregistering non-existent provider gracefully', () => {
      expect(() => scheduler.unregisterTask('nonexistent', 1)).not.toThrow();
    });

    it('clears retry count when a task leaves the paused state', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);
      await vi.advanceTimersToNextTimerAsync();

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(1);

      scheduler.unregisterTask('claude', 1, mockProject);

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('removes only the matching project task when task ids collide', async () => {
      const projectA = makeMockProject('/tmp/project-a');
      const projectB = makeMockProject('/tmp/project-b');
      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, projectA);
      await scheduler.registerPausedTask('claude', 1, projectB);

      scheduler.unregisterTask('claude', 1, projectA);

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);
      expect(mockedResumeTask).toHaveBeenCalledWith(projectB, 1, {
        preserveAutoRetryCount: true,
        quiet: false,
      });
    });

    it('handles project paths containing colons', async () => {
      const colonProject = makeMockProject('/tmp/C:/Users/test');
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, colonProject);
      await vi.advanceTimersToNextTimerAsync();

      expect(scheduler.getRetryCount(colonProject, 1)).toBe(1);

      // Unregister without project clears both timer and retry counts
      // when the timer entry is still present (not yet exhausted).
      // The re-registered timer from the failed resume is still active.
      scheduler.unregisterTask('claude', 1);

      expect(scheduler.getRetryCount(colonProject, 1)).toBe(0);
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('clears retry counts without project after timers are exhausted', async () => {
      const colonProject = makeMockProject('/tmp/C:/Users/test');
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, colonProject);

      // Exhaust retries so the timer is no longer scheduled but retry count remains.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      expect(scheduler.getRetryCount(colonProject, 1)).toBe(5);
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();

      // Unregister without project reference — the fallback path uses the
      // correct key separator to find and clean up orphaned retry counts.
      scheduler.unregisterTask('claude', 1);

      expect(scheduler.getRetryCount(colonProject, 1)).toBe(0);
    });

    it('handles project paths with multiple colons', async () => {
      const multiColonProject = makeMockProject('/path:with:many:colons');

      await scheduler.registerPausedTask('claude', 1, multiColonProject);

      expect(scheduler.getScheduledTime('claude')).toBeDefined();

      scheduler.unregisterTask('claude', 1, multiColonProject);

      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('resets a later pause episode back to retry count zero', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);
      await vi.advanceTimersToNextTimerAsync();

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(1);

      scheduler.unregisterTask('claude', 1, mockProject);
      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
    });
  });

  describe('getScheduledTime', () => {
    it('returns undefined for unregistered provider', () => {
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('clears all timers', async () => {
      const mockProject = makeMockProject();
      await scheduler.registerPausedTask('claude', 1, mockProject);
      await scheduler.registerPausedTask('gemini', 2, mockProject);

      scheduler.destroy();

      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
      expect(scheduler.getScheduledTime('gemini')).toBeUndefined();
    });
  });

  describe('timer firing', () => {
    it('calls resumeTask for all registered tasks when timer fires', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject);
      await scheduler.registerPausedTask('claude', 2, mockProject);

      // Advance time past the scheduled retry
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2 hours

      expect(mockedResumeTask).toHaveBeenCalledTimes(2);
      expect(mockedResumeTask).toHaveBeenCalledWith(mockProject, 1, {
        preserveAutoRetryCount: true,
        quiet: false,
      });
      expect(mockedResumeTask).toHaveBeenCalledWith(mockProject, 2, {
        preserveAutoRetryCount: true,
        quiet: false,
      });

      // Timer should be cleared after firing
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('re-registers tasks that fail to resume', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // Advance to fire only the first timer (not the re-registered one)
      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);

      // Should be re-registered with a new timer
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('stops retrying when resumeTask reports not_resumable', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'not_resumable',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);
      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
    });

    it('re-registers tasks that throw errors during resume', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockRejectedValue(new Error('Container failed'));

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // Advance to fire only the first timer (not the re-registered one)
      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);

      // Should be re-registered for next hour
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('stops retrying after max attempts (5) on persistent failure', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // Fire 5 retry cycles
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      expect(mockedResumeTask).toHaveBeenCalledTimes(5);

      // After 5 failures, should NOT be re-registered
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('stops retrying after max attempts on persistent errors', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockRejectedValue(new Error('Docker broken'));

      await scheduler.registerPausedTask('claude', 1, mockProject);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      expect(mockedResumeTask).toHaveBeenCalledTimes(5);
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('does not re-register a task after it has reached the retry cap', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(mockedResumeTask).toHaveBeenCalledTimes(5);
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('logs a message when registration is skipped due to max retries', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({
        status: 'failed',
        error: 'still paused',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      const logSpy = vi.spyOn(console, 'log');
      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('max auto-retries')
      );
      logSpy.mockRestore();
    });

    it('resets retry count on successful resume so future pauses get full budget', async () => {
      const mockProject = makeMockProject();

      // Fail twice, then succeed
      mockedResumeTask
        .mockResolvedValueOnce({ status: 'failed', error: 'still paused' })
        .mockResolvedValueOnce({ status: 'failed', error: 'still paused' })
        .mockResolvedValueOnce({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // Fire 3 retry cycles
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      expect(mockedResumeTask).toHaveBeenCalledTimes(3);
      // Retry count is reset after a successful resume so that future
      // pauses get the full retry allowance again.
      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
      expect(mockProject.getTask().setAutoRetryCount).toHaveBeenCalledWith(0);
    });

    it('reloads the task after a successful resume before clearing auto-retry count', async () => {
      const staleTask = {
        status: 'PAUSED',
        autoRetryCount: 0,
        restartCount: 0,
        isPaused: () => true,
        isFailed: () => false,
        setAutoRetryCount: vi.fn(),
      };
      const resumedTask = {
        status: 'IN_PROGRESS',
        autoRetryCount: 1,
        restartCount: 0,
        isPaused: () => false,
        isFailed: () => false,
        setAutoRetryCount: vi.fn(),
      };
      const mockProject = {
        path: '/tmp/project',
        getTask: vi
          .fn()
          .mockReturnValueOnce(staleTask) // autoRetryCount seed
          .mockReturnValueOnce(staleTask) // agentModel read
          .mockReturnValueOnce(staleTask) // pre-fire task state check
          .mockReturnValue(resumedTask),
      };

      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject as any);
      await vi.advanceTimersToNextTimerAsync();

      expect(staleTask.setAutoRetryCount).not.toHaveBeenCalled();
      expect(resumedTask.setAutoRetryCount).toHaveBeenCalledWith(0);
    });

    it('keeps backoff independent for tasks from the same provider', async () => {
      const mockProject = makeMockProject();

      mockedResumeTask
        .mockResolvedValueOnce({ status: 'failed', error: 'still paused' })
        .mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject);
      await vi.advanceTimersToNextTimerAsync();

      const backedOffRetry = scheduler.getScheduledTime('claude');
      expect(backedOffRetry).toBeDefined();

      await scheduler.registerPausedTask('claude', 2, mockProject);
      const providerScheduledTime = scheduler.getScheduledTime('claude');

      expect(providerScheduledTime).toBeDefined();
      expect(providerScheduledTime!.getTime()).toBeLessThan(
        backedOffRetry!.getTime()
      );

      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenNthCalledWith(2, mockProject, 2, {
        preserveAutoRetryCount: true,
        quiet: false,
      });
      expect(scheduler.getRetryCount(mockProject, 1)).toBe(1);
      // Retry count reset after successful resume
      expect(scheduler.getRetryCount(mockProject, 2)).toBe(0);
    });
  });

  describe('usage-informed scheduling', () => {
    it('uses reset time when Claude usage is exhausted', async () => {
      const mockProject = makeMockProject();
      // Usage reports exhausted with reset in 30 minutes
      const resetTime = new Date('2026-01-15T14:30:00.000Z');
      mockedCheckClaudeUsage.mockResolvedValue({
        isExhausted: true,
        resetsAt: resetTime,
        utilization: 0.99,
        limitingBucket: 'five_hour',
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      const scheduled = scheduler.getScheduledTimeForTask(mockProject, 1);
      expect(scheduled).toBeDefined();
      // Should be ~30 min + 2-5 min jitter, not 1 hour blind backoff
      const delayMs = scheduled!.getTime() - Date.now();
      expect(delayMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
      expect(delayMs).toBeLessThanOrEqual(35 * 60 * 1000);
    });

    it('uses 5-minute delay when Claude usage is not exhausted', async () => {
      const mockProject = makeMockProject();
      mockedCheckClaudeUsage.mockResolvedValue({
        isExhausted: false,
        resetsAt: null,
        utilization: 0.5,
        limitingBucket: null,
      });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      const scheduled = scheduler.getScheduledTimeForTask(mockProject, 1);
      expect(scheduled).toBeDefined();
      const delayMs = scheduled!.getTime() - Date.now();
      // Should be 5 minutes
      expect(delayMs).toBe(5 * 60 * 1000);
    });

    it('falls back to blind backoff when usage check fails', async () => {
      const mockProject = makeMockProject();
      mockedCheckClaudeUsage.mockResolvedValue(null);

      await scheduler.registerPausedTask('claude', 1, mockProject);

      const scheduled = scheduler.getScheduledTimeForTask(mockProject, 1);
      expect(scheduled).toBeDefined();
      // Should be in the blind backoff range (next hour + 2-10 min jitter)
      expect(scheduled!.getUTCHours()).toBe(15);
      expect(scheduled!.getUTCMinutes()).toBeGreaterThanOrEqual(2);
      expect(scheduled!.getUTCMinutes()).toBeLessThanOrEqual(10);
    });

    it('skips usage check for non-Claude providers', async () => {
      const mockProject = makeMockProject();

      await scheduler.registerPausedTask('gemini', 1, mockProject);

      expect(mockedCheckClaudeUsage).not.toHaveBeenCalled();
      const scheduled = scheduler.getScheduledTimeForTask(mockProject, 1);
      expect(scheduled).toBeDefined();
    });

    it('falls back to blind backoff when usage check throws', async () => {
      const mockProject = makeMockProject();
      mockedCheckClaudeUsage.mockRejectedValue(new Error('Network error'));

      await scheduler.registerPausedTask('claude', 1, mockProject);

      const scheduled = scheduler.getScheduledTimeForTask(mockProject, 1);
      expect(scheduled).toBeDefined();
      // Should be blind backoff
      expect(scheduled!.getUTCHours()).toBe(15);
    });

    it('passes task agentModel to checkClaudeUsage during registration', async () => {
      const mockProject = makeMockProject(
        '/tmp/project',
        'PAUSED',
        0,
        0,
        'sonnet'
      );
      mockedCheckClaudeUsage.mockResolvedValue(null);

      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(mockedCheckClaudeUsage).toHaveBeenCalledWith('sonnet');
    });

    it('passes undefined model when task has no agentModel', async () => {
      const mockProject = makeMockProject();
      mockedCheckClaudeUsage.mockResolvedValue(null);

      await scheduler.registerPausedTask('claude', 1, mockProject);

      expect(mockedCheckClaudeUsage).toHaveBeenCalledWith(undefined);
    });
  });

  describe('pre-fire usage check', () => {
    it('defers retry without burning attempt when still exhausted', async () => {
      const mockProject = makeMockProject();
      // Initial registration: usage check returns null → blind backoff
      mockedCheckClaudeUsage.mockResolvedValue(null);

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // Before timer fires, set usage to exhausted
      const resetTime = new Date(
        Date.now() + 2 * 60 * 60 * 1000 + 30 * 60 * 1000
      ); // 2.5h from now
      mockedCheckClaudeUsage.mockResolvedValue({
        isExhausted: true,
        resetsAt: resetTime,
        utilization: 0.99,
        limitingBucket: 'five_hour',
      });

      await vi.advanceTimersToNextTimerAsync();

      // Should have invalidated cache and checked usage
      expect(mockedInvalidateUsageCache).toHaveBeenCalled();
      // Should NOT have called resumeTask
      expect(mockedResumeTask).not.toHaveBeenCalled();
      // Retry count should not have incremented
      expect(scheduler.getRetryCount(mockProject, 1)).toBe(0);
      // Should be re-scheduled
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('proceeds with resume when usage is available at fire time', async () => {
      const mockProject = makeMockProject();
      mockedCheckClaudeUsage.mockResolvedValue(null);
      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // At fire time, usage is available
      mockedCheckClaudeUsage.mockResolvedValue({
        isExhausted: false,
        resetsAt: null,
        utilization: 0.3,
        limitingBucket: null,
      });

      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);
    });

    it('proceeds with resume when pre-fire usage check fails', async () => {
      const mockProject = makeMockProject();
      mockedCheckClaudeUsage.mockResolvedValue(null);
      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // At fire time, usage check fails
      mockedCheckClaudeUsage.mockRejectedValue(new Error('API down'));

      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);
    });

    it('skips pre-fire usage check for non-Claude providers', async () => {
      const mockProject = makeMockProject();
      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('gemini', 1, mockProject);

      await vi.advanceTimersToNextTimerAsync();

      expect(mockedInvalidateUsageCache).not.toHaveBeenCalled();
      expect(mockedResumeTask).toHaveBeenCalledTimes(1);
    });

    it('passes task agentModel to checkClaudeUsage during pre-fire check', async () => {
      const mockProject = makeMockProject(
        '/tmp/project',
        'PAUSED',
        0,
        0,
        'opus'
      );
      // Initial registration: usage check returns null → blind backoff
      mockedCheckClaudeUsage.mockResolvedValue(null);
      mockedResumeTask.mockResolvedValue({ status: 'ok' });

      await scheduler.registerPausedTask('claude', 1, mockProject);

      // Reset to track only the pre-fire call
      mockedCheckClaudeUsage.mockReset().mockResolvedValue({
        isExhausted: false,
        resetsAt: null,
        utilization: 0.3,
        limitingBucket: null,
      });

      await vi.advanceTimersToNextTimerAsync();

      expect(mockedCheckClaudeUsage).toHaveBeenCalledWith('opus');
    });
  });
});
