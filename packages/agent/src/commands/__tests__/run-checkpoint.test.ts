import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import {
  saveCheckpoint,
  loadCheckpoint,
  isTransientError,
  type CheckpointData,
} from '../run.js';

describe('checkpoint save/load', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rover-checkpoint-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should save and load a checkpoint with completed steps', () => {
    const data: CheckpointData = {
      completedSteps: [
        { id: 'step1', outputs: { result: 'hello' } },
        { id: 'step2', outputs: { summary: 'world' } },
      ],
      failedStepId: 'step3',
      error: 'Rate limit reached',
      isRetryable: true,
    };

    saveCheckpoint(tempDir, data);

    const checkpointPath = join(tempDir, 'checkpoint.json');
    expect(existsSync(checkpointPath)).toBe(true);

    const loaded = loadCheckpoint(checkpointPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.completedSteps).toHaveLength(2);
    expect(loaded!.completedSteps[0].id).toBe('step1');
    expect(loaded!.completedSteps[0].outputs.result).toBe('hello');
    expect(loaded!.completedSteps[1].id).toBe('step2');
    expect(loaded!.failedStepId).toBe('step3');
    expect(loaded!.error).toBe('Rate limit reached');
    expect(loaded!.isRetryable).toBe(true);
  });

  it('should save checkpoint with empty completed steps', () => {
    const data: CheckpointData = {
      completedSteps: [],
      failedStepId: 'step1',
      error: 'Credit limit exhausted',
    };

    saveCheckpoint(tempDir, data);

    const loaded = loadCheckpoint(join(tempDir, 'checkpoint.json'));
    expect(loaded).not.toBeNull();
    expect(loaded!.completedSteps).toHaveLength(0);
    expect(loaded!.failedStepId).toBe('step1');
  });

  it('should return null for non-existent checkpoint file', () => {
    const loaded = loadCheckpoint('/nonexistent/path/checkpoint.json');
    expect(loaded).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const invalidPath = join(tempDir, 'bad-checkpoint.json');
    writeFileSync(invalidPath, 'not valid json', 'utf8');
    const loaded = loadCheckpoint(invalidPath);
    expect(loaded).toBeNull();
  });

  it('should return null for JSON without completedSteps array', () => {
    const badPath = join(tempDir, 'no-steps.json');
    writeFileSync(badPath, JSON.stringify({ error: 'something' }), 'utf8');
    const loaded = loadCheckpoint(badPath);
    expect(loaded).toBeNull();
  });

  it('should not throw when outputDir is undefined', () => {
    expect(() =>
      saveCheckpoint(undefined, {
        completedSteps: [],
        failedStepId: 'step1',
      })
    ).not.toThrow();
  });

  it('should overwrite existing checkpoint on re-save', () => {
    const data1: CheckpointData = {
      completedSteps: [{ id: 'step1', outputs: { a: '1' } }],
      failedStepId: 'step2',
    };
    saveCheckpoint(tempDir, data1);

    const data2: CheckpointData = {
      completedSteps: [
        { id: 'step1', outputs: { a: '1' } },
        { id: 'step2', outputs: { b: '2' } },
      ],
      failedStepId: 'step3',
    };
    saveCheckpoint(tempDir, data2);

    const loaded = loadCheckpoint(join(tempDir, 'checkpoint.json'));
    expect(loaded!.completedSteps).toHaveLength(2);
    expect(loaded!.failedStepId).toBe('step3');
  });

  it('should save and load provider field', () => {
    const data: CheckpointData = {
      completedSteps: [{ id: 'step1', outputs: { result: 'done' } }],
      failedStepId: 'step2',
      error: 'Credit limit',
      isRetryable: true,
      provider: 'claude',
    };

    saveCheckpoint(tempDir, data);

    const loaded = loadCheckpoint(join(tempDir, 'checkpoint.json'));
    expect(loaded).not.toBeNull();
    expect(loaded!.provider).toBe('claude');
  });

  it('should save and load loop progress', () => {
    const data: CheckpointData = {
      completedSteps: [{ id: 'step1', outputs: { result: 'done' } }],
      loopProgress: {
        review_loop: {
          iteration: 2,
          nextSubStepIndex: 1,
          subStepOutputs: {
            run_tests: { exit_code: '1', stderr: 'failed' },
          },
          skippedSubSteps: ['fix_agent'],
        },
      },
      failedStepId: 'review_loop',
    };

    saveCheckpoint(tempDir, data);

    const loaded = loadCheckpoint(join(tempDir, 'checkpoint.json'));
    expect(loaded).not.toBeNull();
    expect(loaded!.loopProgress).toEqual(data.loopProgress);
  });

  it('should handle checkpoint without provider (backward compat)', () => {
    const data: CheckpointData = {
      completedSteps: [],
      failedStepId: 'step1',
    };

    saveCheckpoint(tempDir, data);

    const loaded = loadCheckpoint(join(tempDir, 'checkpoint.json'));
    expect(loaded).not.toBeNull();
    expect(loaded!.provider).toBeUndefined();
  });

  it('should ignore malformed loop progress but still load checkpoint', () => {
    const badPath = join(tempDir, 'bad-loop-progress.json');
    writeFileSync(
      badPath,
      JSON.stringify({
        completedSteps: [{ id: 'step1', outputs: { result: 'ok' } }],
        loopProgress: {
          loop1: {
            iteration: 'two',
            nextSubStepIndex: -1,
            subStepOutputs: 'bad',
          },
        },
      }),
      'utf8'
    );

    const loaded = loadCheckpoint(badPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.completedSteps).toHaveLength(1);
    expect(loaded!.loopProgress).toBeUndefined();
  });
});

describe('isTransientError', () => {
  it('should detect ECONNREFUSED as transient', () => {
    expect(isTransientError('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
  });

  it('should detect ETIMEDOUT as transient', () => {
    expect(isTransientError('connect ETIMEDOUT 1.2.3.4:443')).toBe(true);
  });

  it('should detect ENETUNREACH as transient', () => {
    expect(isTransientError('connect ENETUNREACH')).toBe(true);
  });

  it('should detect "network error" as transient', () => {
    expect(isTransientError('A network error occurred')).toBe(true);
  });

  it('should detect "connection refused" as transient', () => {
    expect(isTransientError('connection refused by server')).toBe(true);
  });

  it('should detect "connection reset" as transient', () => {
    expect(isTransientError('connection reset by peer')).toBe(true);
  });

  it('should detect "connection failed" as transient', () => {
    expect(isTransientError('connection failed to api.anthropic.com')).toBe(
      true
    );
  });

  it('should detect "too many requests" as transient', () => {
    expect(isTransientError('Error 429: too many requests')).toBe(true);
  });

  it('should detect bare 429 status as transient', () => {
    expect(isTransientError('HTTP 429')).toBe(true);
  });

  it('should NOT detect credit limit as transient', () => {
    expect(isTransientError("You've hit your limit")).toBe(false);
  });

  it('should NOT detect usage limit as transient', () => {
    expect(isTransientError('usage limit reached')).toBe(false);
  });

  it('should NOT detect plan limit as transient', () => {
    expect(isTransientError('plan limit exceeded')).toBe(false);
  });

  it('should NOT detect auth error as transient', () => {
    expect(isTransientError('invalid api key')).toBe(false);
  });

  it('should NOT detect empty string as transient', () => {
    expect(isTransientError('')).toBe(false);
  });

  it('should NOT detect credit balance as transient', () => {
    expect(isTransientError('insufficient credit balance')).toBe(false);
  });
});
