import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearProjectRootCache,
  launchSync,
  TaskDescriptionManager,
} from 'rover-core';
import { shellCommand } from '../shell.js';
import {
  createSandbox,
  getAvailableSandboxBackend,
} from '../../lib/sandbox/index.js';

let testDir: string;

vi.mock('../../lib/context.js', () => ({
  requireProjectContext: vi.fn().mockImplementation(() => {
    return Promise.resolve({
      path: testDir,
      getTask: (taskId: number) => {
        const taskPath = join(testDir, '.rover', 'tasks', taskId.toString());
        if (TaskDescriptionManager.exists(taskPath)) {
          return TaskDescriptionManager.load(taskPath, taskId);
        }
        return undefined;
      },
    });
  }),
}));

vi.mock('../../lib/telemetry.js', () => ({
  getTelemetry: vi.fn().mockReturnValue({
    eventShell: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../utils/exit.js', () => ({
  exitWithError: vi.fn().mockImplementation(() => {}),
  exitWithSuccess: vi.fn().mockImplementation(() => {}),
  exitWithWarn: vi.fn().mockImplementation(() => {}),
}));

vi.mock('yocto-spinner', () => ({
  default: vi.fn(() => ({
    start() {
      return this;
    },
    success: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../lib/sandbox/index.js', () => ({
  createSandbox: vi.fn(),
  getAvailableSandboxBackend: vi.fn(),
}));

describe('shell command', () => {
  let originalCwd: string;
  const mockedCreateSandbox = vi.mocked(createSandbox);
  const mockedGetAvailableSandboxBackend = vi.mocked(
    getAvailableSandboxBackend
  );

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rover-shell-test-'));
    originalCwd = process.cwd();
    process.chdir(testDir);

    launchSync('git', ['init']);
    launchSync('git', ['config', 'user.email', 'test@test.com']);
    launchSync('git', ['config', 'user.name', 'Test User']);
    launchSync('git', ['config', 'commit.gpgsign', 'false']);

    writeFileSync('README.md', '# Test');
    launchSync('git', ['add', '.']);
    launchSync('git', ['commit', '-m', 'Initial commit']);

    mkdirSync('.rover/tasks', { recursive: true });
    writeFileSync(
      join(testDir, 'rover.json'),
      JSON.stringify({ name: 'test-project' })
    );

    vi.clearAllMocks();
    mockedGetAvailableSandboxBackend.mockResolvedValue('docker');
    mockedCreateSandbox.mockResolvedValue({
      openShellAtWorktree: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
    clearProjectRootCache();
  });

  const createTestTask = (id: number, title: string = 'Test Task') => {
    const taskPath = join(testDir, '.rover', 'tasks', id.toString());
    const task = TaskDescriptionManager.create(taskPath, {
      id,
      title,
      description: 'Test task description',
      inputs: new Map(),
      workflowName: 'swe',
    });

    const worktreePath = join('.rover', 'tasks', id.toString(), 'workspace');
    const branchName = `rover-task-${id}`;

    launchSync('git', ['worktree', 'add', worktreePath, '-b', branchName]);
    task.setWorkspace(join(testDir, worktreePath), branchName);

    return task;
  };

  it('rejects malformed task IDs with trailing characters', async () => {
    const { exitWithError } = await import('../../utils/exit.js');

    await shellCommand('12abc', { container: false });

    expect(exitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Invalid task ID '12abc' - must be a number",
      }),
      expect.objectContaining({
        telemetry: expect.anything(),
      })
    );
  });

  it.each([
    ['COMPLETED', (task: TaskDescriptionManager) => task.markCompleted()],
    ['FAILED', (task: TaskDescriptionManager) => task.markFailed('boom')],
    ['PAUSED', (task: TaskDescriptionManager) => task.markPaused('paused')],
  ])('preserves sandbox metadata for %s tasks in container shells', async (_status, setTerminalStatus) => {
    const task = createTestTask(1, 'Terminal task');
    setTerminalStatus(task);
    task.setContainerInfo('container-1', 'running', {
      dockerHost: 'tcp://remote:2375',
      serviceContext: {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
    });

    await shellCommand('1', { container: true });

    const reloadedTask = TaskDescriptionManager.load(
      join(testDir, '.rover', 'tasks', '1'),
      1
    );
    expect(mockedCreateSandbox).toHaveBeenCalledWith(reloadedTask, undefined, {
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
  });

  it('preserves persisted serviceContext for active tasks in container shells', async () => {
    const task = createTestTask(2, 'Running task');
    task.markInProgress();
    task.setContainerInfo('container-2', 'running', {
      dockerHost: 'tcp://remote:2375',
      serviceContext: {
        networkName: 'rover-services-2-1',
        containerNames: ['rover-svc-2-1-postgres'],
        taskId: 2,
        iteration: 1,
      },
    });

    await shellCommand('2', { container: true });

    const reloadedTask = TaskDescriptionManager.load(
      join(testDir, '.rover', 'tasks', '2'),
      2
    );
    expect(mockedCreateSandbox).toHaveBeenCalledWith(reloadedTask, undefined, {
      projectPath: testDir,
      sandboxMetadata: {
        dockerHost: 'tcp://remote:2375',
        serviceContext: {
          networkName: 'rover-services-2-1',
          containerNames: ['rover-svc-2-1-postgres'],
          taskId: 2,
          iteration: 1,
        },
      },
    });
  });

  it('reports non-zero exit codes from container shells', async () => {
    const { exitWithWarn, exitWithSuccess } = await import(
      '../../utils/exit.js'
    );
    const task = createTestTask(3, 'Shell failure task');
    task.markInProgress();

    mockedCreateSandbox.mockResolvedValueOnce({
      openShellAtWorktree: vi.fn().mockResolvedValue({ exitCode: 17 }),
    } as any);

    await shellCommand('3', { container: true });

    expect(exitWithWarn).toHaveBeenCalledWith(
      'Shell session ended with code 17',
      expect.any(Object),
      expect.objectContaining({ telemetry: expect.anything() })
    );
    expect(exitWithSuccess).not.toHaveBeenCalled();
  });
});
