import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProjectRootCache, TaskDescriptionManager } from 'rover-core';
import resetCommand from '../reset.js';

let testDir: string;

const { mockTelemetry } = vi.hoisted(() => ({
  mockTelemetry: {
    eventReset: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/context.js', () => ({
  requireProjectContext: vi.fn().mockImplementation(() =>
    Promise.resolve({
      path: testDir,
      getTask: (taskId: number) => {
        const taskPath = join(testDir, '.rover', 'tasks', taskId.toString());
        if (TaskDescriptionManager.exists(taskPath)) {
          return TaskDescriptionManager.load(taskPath, taskId);
        }
        return undefined;
      },
      getTaskPath: (taskId: number) =>
        join(testDir, '.rover', 'tasks', taskId.toString()),
    })
  ),
}));

vi.mock('../../lib/telemetry.js', () => ({
  getTelemetry: vi.fn().mockReturnValue(mockTelemetry),
}));

vi.mock('../../utils/exit.js', () => ({
  exitWithError: vi.fn().mockImplementation(() => {}),
  exitWithWarn: vi.fn().mockImplementation(() => {}),
  exitWithSuccess: vi.fn().mockImplementation(() => {}),
}));

vi.mock('enquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

describe('reset command', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rover-reset-test-'));
    mkdirSync(join(testDir, '.rover', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'rover.json'),
      JSON.stringify({ name: 'test-project' })
    );
    vi.clearAllMocks();
    mockTelemetry.shutdown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    clearProjectRootCache();
    vi.clearAllMocks();
  });

  it('rejects malformed numeric task IDs with trailing characters', async () => {
    const { exitWithError } = await import('../../utils/exit.js');

    await resetCommand.action('12abc', { force: true });

    expect(exitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Invalid task ID '12abc' - must be a number",
      }),
      expect.objectContaining({
        telemetry: expect.anything(),
      })
    );
    expect(mockTelemetry.shutdown).toHaveBeenCalled();
  });
});
