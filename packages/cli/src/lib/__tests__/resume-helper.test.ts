import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock all external dependencies
vi.mock('rover-core', () => ({
  IterationManager: {
    createInitial: vi.fn(),
  },
  IterationStatusManager: {
    createInitial: vi.fn(),
    load: vi.fn(),
  },
  Git: vi.fn().mockImplementation(() => ({
    createWorktree: vi.fn().mockReturnValue(true),
    setupSparseCheckout: vi.fn(),
  })),
  ProjectConfigManager: {
    load: vi.fn().mockReturnValue({
      excludePatterns: [],
    }),
  },
  launchSync: vi.fn().mockReturnValue({
    exitCode: 1,
    stdout: '',
    stderr: '',
  }),
}));

vi.mock('rover-schemas', () => ({
  TaskNotFoundError: class TaskNotFoundError extends Error {
    constructor(id: number) {
      super(`Task ${id} not found`);
      this.name = 'TaskNotFoundError';
    }
  },
}));

vi.mock('../sandbox/index.js', () => ({
  createSandbox: vi.fn(),
}));

vi.mock('../../utils/branch-name.js', () => ({
  generateBranchName: vi.fn().mockReturnValue('rover/task-1'),
}));

vi.mock('../../utils/env-files.js', () => ({
  copyEnvironmentFiles: vi.fn(),
}));

import { resumeTask } from '../resume-helper.js';
import { createSandbox } from '../sandbox/index.js';
import { TaskNotFoundError } from 'rover-schemas';
import {
  Git,
  IterationStatusManager,
  ProjectConfigManager,
  launchSync,
} from 'rover-core';
import { LOCK_STALENESS_TIMEOUT_MS } from '../../utils/resume-lock.js';
import { copyEnvironmentFiles } from '../../utils/env-files.js';

const mockedCreateSandbox = vi.mocked(createSandbox);
const mockedGit = vi.mocked(Git);
const mockedIterationStatusManager = vi.mocked(IterationStatusManager);
const mockedProjectConfigManager = vi.mocked(ProjectConfigManager);
const mockedLaunchSync = vi.mocked(launchSync);
const mockedCopyEnvironmentFiles = vi.mocked(copyEnvironmentFiles);
let mockIterationStatus = {
  pause: vi.fn(),
  fail: vi.fn(),
};

function createMockTask(overrides: Record<string, any> = {}) {
  const merged: any = {
    id: 1,
    title: 'Test task',
    description: 'Test description',
    status: 'PAUSED',
    agent: 'claude',
    worktreePath: '/tmp/worktree',
    branchName: 'rover/task-1',
    sourceBranch: undefined,
    baseCommit: undefined,
    iterations: 1,
    iterationsPath: () => '/tmp/iterations',
    getLastIteration: () => null,
    markInProgress: vi.fn(),
    markResuming: vi.fn(),
    markPaused: vi.fn(),
    markFailed: vi.fn(),
    setAgentImage: vi.fn(),
    setWorkspace: vi.fn(),
    setContainerInfo: vi.fn(),
    ...overrides,
  };
  // Define status methods after spread so they aren't overwritten by overrides
  merged.isPaused = () => merged.status === 'PAUSED';
  merged.isFailed = () => merged.status === 'FAILED';
  return merged;
}

function createMockProject(task?: any) {
  return {
    path: '/tmp/project',
    getTask: vi.fn().mockReturnValue(task || null),
    getWorkspacePath: vi.fn().mockReturnValue('/tmp/workspace-1'),
    getTaskIterationLogsPath: vi
      .fn()
      .mockReturnValue('/tmp/project/logs/tasks/1/iterations/1'),
  } as any;
}

describe('resumeTask', () => {
  let tempDir: string;
  let killSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateSandbox.mockReset();
    mockIterationStatus = {
      pause: vi.fn(),
      fail: vi.fn(),
    };
    mockedIterationStatusManager.createInitial.mockReturnValue(
      mockIterationStatus as any
    );
    mockedIterationStatusManager.load.mockImplementation(() => {
      throw new Error('status.json not found');
    });
    mockedProjectConfigManager.load.mockReturnValue({
      excludePatterns: [],
    } as any);
    mockedLaunchSync.mockReset();
    mockedLaunchSync.mockReturnValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
    } as any);
    tempDir = mkdtempSync(join(tmpdir(), 'rover-resume-helper-test-'));
  });

  afterEach(() => {
    killSpy?.mockRestore();
    killSpy = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true on successful sandbox start', async () => {
    const task = createMockTask({ status: 'PAUSED' });
    const project = createMockProject(task);

    const mockSandbox = {
      createAndStart: vi.fn().mockResolvedValue('container-123'),
    };
    mockedCreateSandbox.mockResolvedValue(mockSandbox as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('ok');
    expect(task.markResuming).toHaveBeenCalled();
    expect(mockedIterationStatusManager.createInitial).toHaveBeenCalledWith(
      '/tmp/iterations/1/status.json',
      '1',
      'Resuming workflow'
    );
    expect(task.setContainerInfo).toHaveBeenCalledWith(
      'container-123',
      'running',
      undefined
    );
  });

  it('passes checkpoint.json to sandbox when resuming a paused iteration', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const worktreePath = join(tempDir, 'worktree');
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath,
      iterationsPath: () => iterationPath,
      iterations: 1,
    });
    const project = createMockProject(task);
    const checkpointPath = join(iterationPath, '1', 'checkpoint.json');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(iterationPath, '1'), { recursive: true });
    writeFileSync(
      checkpointPath,
      '{"completedSteps":[{"id":"step1"}]}',
      'utf8'
    );

    const mockSandbox = {
      createAndStart: vi.fn().mockResolvedValue('container-with-checkpoint'),
    };
    mockedCreateSandbox.mockResolvedValue(mockSandbox as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('ok');
    expect(mockedCopyEnvironmentFiles).toHaveBeenCalledWith(
      project.path,
      worktreePath
    );
    expect(mockedCreateSandbox).toHaveBeenCalledWith(task, undefined, {
      projectPath: project.path,
      checkpointPath,
      resumeFromCheckpoint: true,
      iterationLogsPath: project.getTaskIterationLogsPath(
        task.id,
        task.iterations
      ),
    });
    expect(task.markResuming).toHaveBeenCalled();
    expect(task.setContainerInfo).toHaveBeenCalledWith(
      'container-with-checkpoint',
      'running',
      undefined
    );
    expect(mockedLaunchSync).not.toHaveBeenCalled();
  });

  it('reapplies sparse checkout configuration when resuming from a checkpoint', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const worktreePath = join(tempDir, 'worktree');
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath,
      iterationsPath: () => iterationPath,
      iterations: 1,
    });
    const project = createMockProject(task);
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(iterationPath, '1'), { recursive: true });
    writeFileSync(
      join(iterationPath, '1', 'checkpoint.json'),
      '{"completedSteps":[{"id":"step1"}]}',
      'utf8'
    );
    mockedProjectConfigManager.load.mockReturnValue({
      excludePatterns: ['dist/**'],
    } as any);
    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi.fn().mockResolvedValue('container-with-checkpoint'),
    } as any);

    const result = await resumeTask(project, 1);
    const gitInstance = mockedGit.mock.results.at(-1)?.value as {
      setupSparseCheckout: ReturnType<typeof vi.fn>;
    };

    expect(result.status).toBe('ok');
    expect(mockedCopyEnvironmentFiles).toHaveBeenCalledWith(
      project.path,
      worktreePath
    );
    expect(gitInstance.setupSparseCheckout).toHaveBeenCalledWith(worktreePath, [
      'dist/**',
    ]);
  });

  it('ignores malformed checkpoints and recreates a clean worktree', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const worktreePath = join(tempDir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath,
      branchName: 'rover/task-1',
      sourceBranch: 'main',
      iterationsPath: () => iterationPath,
      iterations: 1,
    });
    const project = createMockProject(task);
    const checkpointPath = join(iterationPath, '1', 'checkpoint.json');
    mkdirSync(join(iterationPath, '1'), { recursive: true });
    writeFileSync(checkpointPath, '{"foo":"bar"}', 'utf8');

    mockedLaunchSync
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } as any)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } as any)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } as any);
    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi.fn().mockResolvedValue('container-rerun'),
    } as any);

    const result = await resumeTask(project, 1);
    const gitInstance = mockedGit.mock.results.at(-1)?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };

    expect(result.status).toBe('ok');
    expect(mockedLaunchSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['worktree', 'remove', worktreePath, '--force'],
      { cwd: project.path, reject: false }
    );
    expect(gitInstance.createWorktree).toHaveBeenCalledWith(
      worktreePath,
      'rover/task-1',
      'main'
    );
    expect(mockedCreateSandbox).toHaveBeenCalledWith(task, undefined, {
      projectPath: project.path,
      checkpointPath: undefined,
      resumeFromCheckpoint: false,
      iterationLogsPath: project.getTaskIterationLogsPath(
        task.id,
        task.iterations
      ),
    });
  });

  it('returns not_resumable for non-PAUSED/FAILED tasks', async () => {
    const task = createMockTask({ status: 'IN_PROGRESS' });
    const project = createMockProject(task);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('not_resumable');
    expect(task.markResuming).not.toHaveBeenCalled();
  });

  it('returns not_resumable when task has zero iterations', async () => {
    const task = createMockTask({ status: 'PAUSED', iterations: 0 });
    const project = createMockProject(task);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('not_resumable');
    expect(task.markResuming).not.toHaveBeenCalled();
    expect(mockedCreateSandbox).not.toHaveBeenCalled();
  });

  it('returns failed on sandbox creation failure', async () => {
    const task = createMockTask({ status: 'PAUSED' });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi
        .fn()
        .mockRejectedValue(new Error('Docker not available')),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(mockIterationStatus.pause).toHaveBeenCalledWith(
      'Resuming workflow',
      'Resume failed: container could not start',
      undefined
    );
    expect(task.markPaused).toHaveBeenCalledWith(
      'Resume failed: container could not start'
    );
    expect(mockIterationStatus.fail).not.toHaveBeenCalled();
  });

  it('preserves the paused provider when sandbox startup fails after status reset', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const task = createMockTask({
      status: 'PAUSED',
      iterationsPath: () => iterationPath,
      iterations: 1,
    });
    const project = createMockProject(task);
    mkdirSync(join(iterationPath, '1'), { recursive: true });
    writeFileSync(join(iterationPath, '1', 'status.json'), '{}', 'utf8');
    mockedIterationStatusManager.load.mockReturnValue({
      provider: 'claude',
    } as any);
    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi
        .fn()
        .mockRejectedValue(new Error('Docker not available')),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(mockedIterationStatusManager.load).toHaveBeenCalledWith(
      join(iterationPath, '1', 'status.json')
    );
    expect(mockIterationStatus.pause).toHaveBeenCalledWith(
      'Resuming workflow',
      'Resume failed: container could not start',
      'claude'
    );
  });

  it('throws TaskNotFoundError for non-existent task', async () => {
    const project = createMockProject(null);

    await expect(resumeTask(project, 999)).rejects.toThrow(TaskNotFoundError);
  });

  it('works for FAILED tasks too', async () => {
    const task = createMockTask({ status: 'FAILED' });
    const project = createMockProject(task);

    const mockSandbox = {
      createAndStart: vi.fn().mockResolvedValue('container-456'),
    };
    mockedCreateSandbox.mockResolvedValue(mockSandbox as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('ok');
    expect(task.markResuming).toHaveBeenCalled();
  });

  it('restores FAILED status when container start fails during resume', async () => {
    const task = createMockTask({
      status: 'FAILED',
      error: 'Previous failure',
    });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi
        .fn()
        .mockRejectedValue(new Error('Docker not available')),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(task.markFailed).toHaveBeenCalledWith('Previous failure');
    expect(task.markPaused).not.toHaveBeenCalled();
    expect(mockIterationStatus.fail).toHaveBeenCalledWith(
      'Resuming workflow',
      'Resume failed: container could not start'
    );
    expect(mockIterationStatus.pause).not.toHaveBeenCalled();
  });

  it('clears stale dead-process resume locks and proceeds', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const task = createMockTask({
      status: 'PAUSED',
      iterationsPath: () => iterationPath,
    });
    const project = createMockProject(task);

    const lockDir = join(iterationPath, '1');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.resume.lock');
    // Extremely large PID is not expected to exist; lock should be treated as stale.
    writeFileSync(lockPath, '99999999', 'utf8');

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi.fn().mockResolvedValue('container-stale-lock'),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('ok');
    expect(task.markResuming).toHaveBeenCalled();
    expect(task.setContainerInfo).toHaveBeenCalledWith(
      'container-stale-lock',
      'running',
      undefined
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not steal an old resume lock when owner process is still alive', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const task = createMockTask({
      status: 'PAUSED',
      iterationsPath: () => iterationPath,
    });
    const project = createMockProject(task);

    const lockDir = join(iterationPath, '1');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.resume.lock');
    writeFileSync(lockPath, '424242', 'utf8');

    // Make the lock appear old; it should still be respected if owner is alive.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, old, old);

    killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number | bigint) => {
        if (pid === 424242) return true as any;
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      });

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('already_resuming');
    expect(mockedCreateSandbox).not.toHaveBeenCalled();
    expect(task.markResuming).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('does not bypass an existing lock owned by the current process', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const task = createMockTask({
      status: 'PAUSED',
      iterationsPath: () => iterationPath,
    });
    const project = createMockProject(task);

    const lockDir = join(iterationPath, '1');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.resume.lock');
    writeFileSync(lockPath, String(process.pid), 'utf8');

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('already_resuming');
    expect(mockedCreateSandbox).not.toHaveBeenCalled();
    expect(task.markResuming).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('recreates a missing worktree even when task metadata is present', async () => {
    const missingWorktreePath = join(tempDir, 'missing-worktree');
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath: missingWorktreePath,
      branchName: 'rover/task-1',
      sourceBranch: 'main',
    });
    const project = createMockProject(task);

    const mockSandbox = {
      createAndStart: vi.fn().mockResolvedValue('container-789'),
    };
    mockedCreateSandbox.mockResolvedValue(mockSandbox as any);

    const result = await resumeTask(project, 1);
    const gitInstance = mockedGit.mock.results.at(-1)?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };

    expect(result.status).toBe('ok');
    expect(project.getWorkspacePath).not.toHaveBeenCalled();
    expect(mockedGit).toHaveBeenCalledWith({ cwd: project.path });
    expect(gitInstance.createWorktree).toHaveBeenCalledWith(
      missingWorktreePath,
      'rover/task-1',
      'main'
    );
    expect(task.setWorkspace).toHaveBeenCalledWith(
      missingWorktreePath,
      'rover/task-1'
    );
  });

  it('recreates an existing worktree before full rerun when no checkpoint exists', async () => {
    const worktreePath = join(tempDir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath,
      branchName: 'rover/task-1',
      sourceBranch: 'main',
    });
    const project = createMockProject(task);

    mockedLaunchSync
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } as any)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } as any)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: '',
        stderr: '',
      } as any);
    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi.fn().mockResolvedValue('container-789'),
    } as any);

    const result = await resumeTask(project, 1);
    const gitInstance = mockedGit.mock.results.at(-1)?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };

    expect(result.status).toBe('ok');
    expect(mockedLaunchSync).toHaveBeenNthCalledWith(
      1,
      'git',
      ['worktree', 'remove', worktreePath, '--force'],
      { cwd: project.path, reject: false }
    );
    expect(mockedLaunchSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/heads/rover/task-1'],
      { cwd: project.path, reject: false }
    );
    expect(mockedLaunchSync).toHaveBeenNthCalledWith(
      3,
      'git',
      ['branch', '-D', 'rover/task-1'],
      { cwd: project.path, reject: false }
    );
    expect(gitInstance.createWorktree).toHaveBeenCalledWith(
      worktreePath,
      'rover/task-1',
      'main'
    );
  });

  it('prefers the stored base commit when recreating a missing worktree', async () => {
    const missingWorktreePath = join(tempDir, 'missing-worktree');
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath: missingWorktreePath,
      branchName: 'rover/task-1',
      sourceBranch: 'main',
      baseCommit: 'abc123',
    });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi.fn().mockResolvedValue('container-789'),
    } as any);

    const result = await resumeTask(project, 1);
    const gitInstance = mockedGit.mock.results.at(-1)?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };

    expect(result.status).toBe('ok');
    expect(gitInstance.createWorktree).toHaveBeenCalledWith(
      missingWorktreePath,
      'rover/task-1',
      'abc123'
    );
  });

  it('refuses checkpoint resume when the task worktree has been recreated', async () => {
    const iterationPath = join(tempDir, 'iterations');
    const missingWorktreePath = join(tempDir, 'missing-worktree');
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath: missingWorktreePath,
      branchName: 'rover/task-1',
      sourceBranch: 'main',
      iterationsPath: () => iterationPath,
      iterations: 1,
    });
    const project = createMockProject(task);
    const checkpointPath = join(iterationPath, '1', 'checkpoint.json');
    mkdirSync(join(iterationPath, '1'), { recursive: true });
    writeFileSync(
      checkpointPath,
      '{"completedSteps":[{"id":"step1"}]}',
      'utf8'
    );

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({
      error:
        'Resume failed: task worktree is missing and cannot be recreated safely from a checkpoint',
    });
    const gitInstance = mockedGit.mock.results.at(-1)?.value as {
      createWorktree: ReturnType<typeof vi.fn>;
    };
    expect(gitInstance.createWorktree).not.toHaveBeenCalled();
    expect(mockedCreateSandbox).not.toHaveBeenCalled();
    expect(task.markPaused).toHaveBeenCalledWith(
      'Resume failed: task worktree is missing and cannot be recreated safely from a checkpoint'
    );
  });

  it('restores PAUSED status when worktree creation fails before sandbox start', async () => {
    const missingWorktreePath = join(tempDir, 'missing-worktree');
    const task = createMockTask({
      status: 'PAUSED',
      worktreePath: missingWorktreePath,
      error: 'Paused earlier',
      sourceBranch: 'main',
    });
    const project = createMockProject(task);

    mockedGit.mockImplementationOnce(
      () =>
        ({
          createWorktree: vi.fn().mockImplementation(() => {
            throw new Error('git worktree add failed');
          }),
          setupSparseCheckout: vi.fn(),
        }) as any
    );

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(task.markPaused).toHaveBeenCalledWith('Paused earlier');
  });

  it('restores PAUSED status when createSandbox itself throws', async () => {
    const task = createMockTask({
      status: 'PAUSED',
      error: 'Paused by user',
    });
    const project = createMockProject(task);

    mockedCreateSandbox.mockRejectedValue(
      new Error('Failed to pull agent image')
    );

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(task.markResuming).toHaveBeenCalled();
    expect(task.markPaused).toHaveBeenCalledWith('Paused by user');
    expect(task.markFailed).not.toHaveBeenCalled();
    expect(mockIterationStatus.pause).toHaveBeenCalledWith(
      'Resuming workflow',
      'Resume failed: container could not start',
      undefined
    );
    expect(mockIterationStatus.fail).not.toHaveBeenCalled();
  });

  it('restores FAILED status when createSandbox itself throws', async () => {
    const task = createMockTask({
      status: 'FAILED',
      error: 'Agent crashed',
    });
    const project = createMockProject(task);

    mockedCreateSandbox.mockRejectedValue(
      new Error('Failed to pull agent image')
    );

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(task.markResuming).toHaveBeenCalled();
    expect(task.markFailed).toHaveBeenCalledWith('Agent crashed');
    expect(task.markPaused).not.toHaveBeenCalled();
    expect(mockIterationStatus.fail).toHaveBeenCalledWith(
      'Resuming workflow',
      'Resume failed: container could not start'
    );
    expect(mockIterationStatus.pause).not.toHaveBeenCalled();
  });

  it('restores PAUSED status with fallback message when createAndStart throws and no prior error exists', async () => {
    const task = createMockTask({ status: 'PAUSED' });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi
        .fn()
        .mockRejectedValue(new Error('container runtime unavailable')),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(task.markPaused).toHaveBeenCalledWith(
      'Resume failed: container could not start'
    );
    expect(task.markFailed).not.toHaveBeenCalled();
  });

  it('restores FAILED status with fallback message when createAndStart throws and no prior error exists', async () => {
    const task = createMockTask({ status: 'FAILED' });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi
        .fn()
        .mockRejectedValue(new Error('container runtime unavailable')),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('failed');
    expect(task.markFailed).toHaveBeenCalledWith(
      'Resume failed: container could not start'
    );
    expect(task.markPaused).not.toHaveBeenCalled();
  });

  it('marks task in progress before resetting status and storing container info', async () => {
    const callOrder: string[] = [];
    mockedIterationStatusManager.createInitial.mockImplementation(() => {
      callOrder.push('status');
      return {} as any;
    });
    const task = createMockTask({ status: 'PAUSED' });
    task.setContainerInfo.mockImplementation(() => {
      callOrder.push('container');
    });
    task.markResuming.mockImplementation(() => {
      callOrder.push('task');
    });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi.fn().mockResolvedValue('container-123'),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result.status).toBe('ok');
    expect(callOrder).toEqual(['task', 'status', 'container']);
  });

  describe('concurrent resume lock contention', () => {
    it('returns already_resuming when lock file exists with a live PID', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      const lockDir = join(iterationPath, '1');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, '.resume.lock');
      writeFileSync(lockPath, '112233', 'utf8');

      // Simulate the owning PID being alive: process.kill(pid, 0) succeeds
      killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid: number | bigint) => {
          if (pid === 112233) return true as any;
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });

      const result = await resumeTask(project, 1);

      expect(result.status).toBe('already_resuming');
      expect(mockedCreateSandbox).not.toHaveBeenCalled();
      expect(task.markResuming).not.toHaveBeenCalled();
      // Lock file should remain untouched with original PID
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, 'utf8')).toBe('112233');
    });

    it('reclaims a stale lock from a dead PID and resumes successfully', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      const lockDir = join(iterationPath, '1');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, '.resume.lock');
      writeFileSync(lockPath, '554433', 'utf8');

      // Simulate the owning PID being dead: process.kill(pid, 0) throws ESRCH
      killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((_pid: number | bigint) => {
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });

      mockedCreateSandbox.mockResolvedValue({
        createAndStart: vi.fn().mockResolvedValue('container-reclaimed'),
      } as any);

      const result = await resumeTask(project, 1);

      expect(result.status).toBe('ok');
      expect(task.markResuming).toHaveBeenCalled();
      expect(task.setContainerInfo).toHaveBeenCalledWith(
        'container-reclaimed',
        'running',
        undefined
      );
      // After successful resume, the lock should be released (cleaned up)
      expect(existsSync(lockPath)).toBe(false);
    });

    it('returns already_resuming when stale-lock reclaim is in progress', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      const lockDir = join(iterationPath, '1');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, '.resume.lock');
      writeFileSync(lockPath, '554433', 'utf8');
      const reclaimLockPath = `${lockPath}.reclaim`;
      writeFileSync(reclaimLockPath, '998877', 'utf8');

      // Stale main lock + active reclaim lock should not be stolen.
      killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid: number | bigint) => {
          if (pid === 998877) {
            return true as any;
          }
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });

      const result = await resumeTask(project, 1);

      expect(result.status).toBe('already_resuming');
      expect(mockedCreateSandbox).not.toHaveBeenCalled();
      expect(task.markResuming).not.toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(true);
    });

    it('reclaims stale reclaim lock left by dead process and resumes', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      const lockDir = join(iterationPath, '1');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, '.resume.lock');
      writeFileSync(lockPath, '554433', 'utf8');
      const reclaimLockPath = `${lockPath}.reclaim`;
      writeFileSync(reclaimLockPath, '998877', 'utf8');

      killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((_pid: number | bigint) => {
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });

      mockedCreateSandbox.mockResolvedValue({
        createAndStart: vi.fn().mockResolvedValue('container-reclaim-stale'),
      } as any);

      const result = await resumeTask(project, 1);

      expect(result.status).toBe('ok');
      expect(task.markResuming).toHaveBeenCalled();
      expect(task.setContainerInfo).toHaveBeenCalledWith(
        'container-reclaim-stale',
        'running',
        undefined
      );
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(reclaimLockPath)).toBe(false);
    });

    it('reclaims stale reclaim lock by age even when PID appears alive', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      const lockDir = join(iterationPath, '1');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, '.resume.lock');
      writeFileSync(lockPath, '554433', 'utf8');
      const reclaimLockPath = `${lockPath}.reclaim`;
      writeFileSync(
        reclaimLockPath,
        `998877:${Date.now() - LOCK_STALENESS_TIMEOUT_MS - 1000}`,
        'utf8'
      );

      // Reclaim lock owner looks alive, but lock is stale by timestamp.
      killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid: number | bigint) => {
          if (pid === 998877) {
            return true as any;
          }
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });

      mockedCreateSandbox.mockResolvedValue({
        createAndStart: vi.fn().mockResolvedValue('container-stale-reclaim'),
      } as any);

      const result = await resumeTask(project, 1);

      expect(result.status).toBe('ok');
      expect(task.markResuming).toHaveBeenCalled();
      expect(task.setContainerInfo).toHaveBeenCalledWith(
        'container-stale-reclaim',
        'running',
        undefined
      );
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(reclaimLockPath)).toBe(false);
    });

    it('second caller fails gracefully when two callers race to acquire the lock', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      // Use a deferred promise so the first caller's sandbox blocks until we
      // explicitly resolve it, guaranteeing the lock is held when the second
      // caller attempts to acquire it.
      let resolveFirstSandbox!: (value: string) => void;
      const firstSandboxPromise = new Promise<string>(resolve => {
        resolveFirstSandbox = resolve;
      });

      let sandboxCallCount = 0;
      mockedCreateSandbox.mockImplementation(async () => {
        sandboxCallCount++;
        if (sandboxCallCount === 1) {
          return {
            createAndStart: vi
              .fn()
              .mockImplementation(() => firstSandboxPromise),
          } as any;
        }
        // Second caller should never reach sandbox creation
        return {
          createAndStart: vi.fn().mockResolvedValue('container-second'),
        } as any;
      });

      // Start the first resume -- it acquires the lock synchronously, then
      // awaits createAndStart which blocks on our deferred promise.
      const firstResume = resumeTask(project, 1);

      // Yield to let the first caller reach the await inside createAndStart,
      // which means the lock file already exists with process.pid.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Start the second resume while the first still holds the lock.
      // The lock file contains our own PID (process.pid), which is alive,
      // so the second caller cannot reclaim it.
      const secondResume = resumeTask(project, 1);
      const secondResult = await secondResume;

      // Second caller should fail gracefully
      expect(secondResult.status).toBe('already_resuming');

      // Now let the first caller finish
      resolveFirstSandbox('container-winner');
      const firstResult = await firstResume;

      // First caller should succeed
      expect(firstResult.status).toBe('ok');

      // The lock should be released after the successful caller finishes
      const lockPath = join(iterationPath, '1', '.resume.lock');
      expect(existsSync(lockPath)).toBe(false);
    });

    it('allows only one winner across many concurrent callers', async () => {
      const iterationPath = join(tempDir, 'iterations');
      const task = createMockTask({
        status: 'PAUSED',
        iterationsPath: () => iterationPath,
      });
      const project = createMockProject(task);

      let resolveFirstSandbox!: (value: string) => void;
      const firstSandboxPromise = new Promise<string>(resolve => {
        resolveFirstSandbox = resolve;
      });

      let sandboxCallCount = 0;
      mockedCreateSandbox.mockImplementation(async () => {
        sandboxCallCount++;
        return {
          createAndStart:
            sandboxCallCount === 1
              ? vi.fn().mockImplementation(() => firstSandboxPromise)
              : vi.fn().mockResolvedValue('container-loser'),
        } as any;
      });

      const firstResume = resumeTask(project, 1);
      await new Promise(resolve => setTimeout(resolve, 0));

      const competitors = await Promise.all(
        Array.from({ length: 8 }, () => resumeTask(project, 1))
      );

      for (const result of competitors) {
        expect(result.status).toBe('already_resuming');
      }

      resolveFirstSandbox('container-winner-many');
      const firstResult = await firstResume;

      expect(firstResult.status).toBe('ok');
      expect(mockedCreateSandbox).toHaveBeenCalledTimes(1);
      const lockPath = join(iterationPath, '1', '.resume.lock');
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
