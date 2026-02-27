import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RetryScheduler, calculateNextRetryTime } from '../retry-scheduler.js';

// Mock the resume-helper module
vi.mock('../resume-helper.js', () => ({
  resumeTask: vi.fn(),
}));

import { resumeTask } from '../resume-helper.js';

const mockedResumeTask = vi.mocked(resumeTask);

describe('RetryScheduler', () => {
  let scheduler: RetryScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new RetryScheduler();
    mockedResumeTask.mockReset();
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  describe('calculateNextRetryTime', () => {
    it('returns a time in the next hour + 2-10 min jitter', () => {
      const now = new Date('2026-01-15T14:30:00.000Z');
      // Run multiple times to verify range
      for (let i = 0; i < 20; i++) {
        const result = calculateNextRetryTime(now);
        // Should be in the 15:02-15:10 UTC range
        expect(result.getUTCHours()).toBe(15);
        expect(result.getUTCMinutes()).toBeGreaterThanOrEqual(2);
        expect(result.getUTCMinutes()).toBeLessThanOrEqual(10);
      }
    });

    it('wraps around midnight correctly', () => {
      const now = new Date('2026-01-15T23:45:00.000Z');
      const result = calculateNextRetryTime(now);
      // Should be next day 00:02-00:10 UTC
      expect(result.getUTCDate()).toBe(16);
      expect(result.getUTCHours()).toBe(0);
      expect(result.getUTCMinutes()).toBeGreaterThanOrEqual(2);
      expect(result.getUTCMinutes()).toBeLessThanOrEqual(10);
    });
  });

  describe('registerPausedTask', () => {
    it('creates a new timer for a new provider', () => {
      const mockProject = {} as any;
      scheduler.registerPausedTask('claude', 1, mockProject);

      const scheduledTime = scheduler.getScheduledTime('claude');
      expect(scheduledTime).toBeDefined();
      expect(scheduledTime!.getTime()).toBeGreaterThan(Date.now());
    });

    it('reuses existing timer when registering same provider twice', () => {
      const mockProject = {} as any;
      scheduler.registerPausedTask('claude', 1, mockProject);
      const firstScheduledTime = scheduler.getScheduledTime('claude');

      scheduler.registerPausedTask('claude', 2, mockProject);
      const secondScheduledTime = scheduler.getScheduledTime('claude');

      // Same timer, same time
      expect(firstScheduledTime).toEqual(secondScheduledTime);
    });

    it('creates separate timers for different providers', () => {
      const mockProject = {} as any;
      scheduler.registerPausedTask('claude', 1, mockProject);
      scheduler.registerPausedTask('gemini', 2, mockProject);

      expect(scheduler.getScheduledTime('claude')).toBeDefined();
      expect(scheduler.getScheduledTime('gemini')).toBeDefined();
    });
  });

  describe('unregisterTask', () => {
    it('removes a task from the provider group', () => {
      const mockProject = {} as any;
      scheduler.registerPausedTask('claude', 1, mockProject);
      scheduler.registerPausedTask('claude', 2, mockProject);

      scheduler.unregisterTask('claude', 1);

      // Timer should still exist (task 2 remains)
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('clears timer when last task for provider is removed', () => {
      const mockProject = {} as any;
      scheduler.registerPausedTask('claude', 1, mockProject);

      scheduler.unregisterTask('claude', 1);

      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('handles unregistering non-existent provider gracefully', () => {
      expect(() => scheduler.unregisterTask('nonexistent', 1)).not.toThrow();
    });
  });

  describe('getScheduledTime', () => {
    it('returns undefined for unregistered provider', () => {
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('clears all timers', () => {
      const mockProject = {} as any;
      scheduler.registerPausedTask('claude', 1, mockProject);
      scheduler.registerPausedTask('gemini', 2, mockProject);

      scheduler.destroy();

      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
      expect(scheduler.getScheduledTime('gemini')).toBeUndefined();
    });
  });

  describe('timer firing', () => {
    it('calls resumeTask for all registered tasks when timer fires', async () => {
      const mockProject = {} as any;
      mockedResumeTask.mockResolvedValue(true);

      scheduler.registerPausedTask('claude', 1, mockProject);
      scheduler.registerPausedTask('claude', 2, mockProject);

      // Advance time past the scheduled retry
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2 hours

      expect(mockedResumeTask).toHaveBeenCalledTimes(2);
      expect(mockedResumeTask).toHaveBeenCalledWith(mockProject, 1);
      expect(mockedResumeTask).toHaveBeenCalledWith(mockProject, 2);

      // Timer should be cleared after firing
      expect(scheduler.getScheduledTime('claude')).toBeUndefined();
    });

    it('re-registers tasks that fail to resume', async () => {
      const mockProject = {} as any;
      mockedResumeTask.mockResolvedValue(false);

      scheduler.registerPausedTask('claude', 1, mockProject);

      // Advance to fire only the first timer (not the re-registered one)
      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);

      // Should be re-registered with a new timer
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });

    it('re-registers tasks that throw errors during resume', async () => {
      const mockProject = {} as any;
      mockedResumeTask.mockRejectedValue(new Error('Container failed'));

      scheduler.registerPausedTask('claude', 1, mockProject);

      // Advance to fire only the first timer (not the re-registered one)
      await vi.advanceTimersToNextTimerAsync();

      expect(mockedResumeTask).toHaveBeenCalledTimes(1);

      // Should be re-registered for next hour
      expect(scheduler.getScheduledTime('claude')).toBeDefined();
    });
  });
});
