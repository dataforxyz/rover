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

  it('tears down sidecars after a graceful pause and preserves resumable sandbox metadata', async () => {
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
      teardownServices: vi.fn().mockResolvedValue(undefined),
      stopGracefully: vi.fn().mockResolvedValue(undefined),
      getSandboxMetadata: vi.fn().mockReturnValue({
        dockerHost: 'tcp://remote:2375',
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
    expect(sandbox.teardownServices).toHaveBeenCalledTimes(1);
    expect(sandbox.stopGracefully).not.toHaveBeenCalled();
    expect(reloadedTask.status).toBe('PAUSED');
    expect(reloadedTask.containerId).toBe('');
    expect(reloadedTask.sandboxMetadata).toEqual({
      dockerHost: 'tcp://remote:2375',
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
});
