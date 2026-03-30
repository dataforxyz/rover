import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProjectRootCache, TaskDescriptionManager } from 'rover-core';
import { pauseCommand } from '../pause.js';

let testDir: string;

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
      getTaskIterationLogsPath: (taskId: number, iteration: number) =>
        join(
          testDir,
          '.rover',
          'tasks',
          taskId.toString(),
          'iterations',
          iteration.toString(),
          'logs'
        ),
    })
  ),
  isJsonMode: vi.fn().mockReturnValue(false),
  setJsonMode: vi.fn(),
}));

vi.mock('../../lib/telemetry.js', () => ({
  getTelemetry: vi.fn().mockReturnValue({
    shutdown: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../utils/exit.js', () => ({
  exitWithError: vi.fn().mockImplementation(() => {}),
  exitWithSuccess: vi.fn().mockImplementation(() => {}),
}));

vi.mock('../../lib/sandbox/index.js', () => ({
  createSandbox: vi.fn(),
}));

describe('pause command', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rover-pause-test-'));
    mkdirSync(join(testDir, '.rover', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'rover.json'),
      JSON.stringify({ name: 'test-project' })
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    clearProjectRootCache();
    vi.clearAllMocks();
  });

  function createTestTask(id: number): TaskDescriptionManager {
    const taskPath = join(testDir, '.rover', 'tasks', id.toString());
    const task = TaskDescriptionManager.create(taskPath, {
      id,
      title: `Task ${id}`,
      description: 'Pause test task',
      inputs: new Map(),
      workflowName: 'swe',
    });
    task.markInProgress();
    return task;
  }

  it('rejects malformed task IDs with trailing characters', async () => {
    const { exitWithError } = await import('../../utils/exit.js');

    await pauseCommand('12abc', { json: true });

    expect(exitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid task ID '12abc' - must be a number",
      }),
      expect.objectContaining({
        telemetry: expect.anything(),
      })
    );
  });

  it('preserves sidecars after a graceful pause so resume can reuse them', async () => {
    const { createSandbox } = await import('../../lib/sandbox/index.js');
    const { exitWithSuccess } = await import('../../utils/exit.js');

    const task = createTestTask(1);
    const iterationPath = join(
      testDir,
      '.rover',
      'tasks',
      '1',
      'iterations',
      '1'
    );
    mkdirSync(iterationPath, { recursive: true });
    writeFileSync(join(iterationPath, 'checkpoint.json'), '{"ok":true}');

    task.setContainerInfo('container-1', 'running', {
      dockerHost: 'tcp://remote:2375',
      serviceContext: {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
    });

    const sandbox = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ status: 'exited' }),
      stopGracefully: vi.fn().mockResolvedValue(undefined),
      getSandboxMetadata: vi.fn().mockReturnValue({
        dockerHost: 'tcp://remote:2375',
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      }),
    };
    vi.mocked(createSandbox).mockResolvedValue(sandbox as any);

    await pauseCommand('1', { json: true, reason: 'Paused for maintenance' });

    const reloadedTask = TaskDescriptionManager.load(
      join(testDir, '.rover', 'tasks', '1'),
      1
    );

    const createSandboxCall = vi.mocked(createSandbox).mock.calls[0];
    expect(createSandboxCall?.[0]).toEqual(expect.objectContaining({ id: 1 }));
    expect(createSandboxCall?.[2]).toEqual({
      projectPath: testDir,
      sandboxMetadata: {
        dockerHost: 'tcp://remote:2375',
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });
    expect(sandbox.stopGracefully).not.toHaveBeenCalled();
    expect(sandbox.inspect).toHaveBeenNthCalledWith(1, {
      teardownServices: false,
    });
    expect(sandbox.inspect).toHaveBeenNthCalledWith(2, {
      teardownServices: false,
    });
    expect(reloadedTask.status).toBe('PAUSED');
    expect(reloadedTask.containerId).toBe('');
    expect(reloadedTask.sandboxMetadata).toEqual({
      dockerHost: 'tcp://remote:2375',
      serviceContext: {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
    });
    expect(exitWithSuccess).toHaveBeenCalledWith(
      'Task paused successfully!',
      expect.objectContaining({
        success: true,
        taskId: 1,
        status: 'PAUSED',
        hasCheckpoint: true,
        reason: 'Paused for maintenance',
      }),
      expect.objectContaining({
        telemetry: expect.anything(),
      })
    );
  });

  it('returns an already-paused error for paused tasks', async () => {
    const { exitWithError } = await import('../../utils/exit.js');

    const task = createTestTask(2);
    task.markPaused('Paused earlier');

    await pauseCommand('2', { json: true });

    expect(exitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Task 2 is already paused',
      }),
      expect.objectContaining({
        telemetry: expect.anything(),
      })
    );
  });
});
