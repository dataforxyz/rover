import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
vi.mock('rover-core', () => ({
  IterationManager: {
    createInitial: vi.fn(),
  },
  Git: vi.fn().mockImplementation(() => ({
    createWorktree: vi.fn(),
    setupSparseCheckout: vi.fn(),
  })),
  ProjectConfigManager: {
    load: vi.fn().mockReturnValue({
      excludePatterns: [],
    }),
  },
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

const mockedCreateSandbox = vi.mocked(createSandbox);

function createMockTask(overrides: Record<string, any> = {}) {
  const merged = {
    id: 1,
    title: 'Test task',
    description: 'Test description',
    status: 'PAUSED',
    agent: 'claude',
    worktreePath: '/tmp/worktree',
    branchName: 'rover/task-1',
    iterations: 1,
    iterationsPath: () => '/tmp/iterations',
    getLastIteration: () => null,
    markInProgress: vi.fn(),
    markPaused: vi.fn(),
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
  } as any;
}

describe('resumeTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateSandbox.mockReset();
  });

  it('returns true on successful sandbox start', async () => {
    const task = createMockTask({ status: 'PAUSED' });
    const project = createMockProject(task);

    const mockSandbox = {
      createAndStart: vi.fn().mockResolvedValue('container-123'),
    };
    mockedCreateSandbox.mockResolvedValue(mockSandbox as any);

    const result = await resumeTask(project, 1);

    expect(result).toBe(true);
    expect(task.markInProgress).toHaveBeenCalled();
    expect(task.setContainerInfo).toHaveBeenCalledWith(
      'container-123',
      'running',
      undefined
    );
  });

  it('returns false for non-PAUSED/FAILED tasks', async () => {
    const task = createMockTask({ status: 'IN_PROGRESS' });
    const project = createMockProject(task);

    const result = await resumeTask(project, 1);

    expect(result).toBe(false);
    expect(task.markInProgress).not.toHaveBeenCalled();
  });

  it('returns false on sandbox creation failure', async () => {
    const task = createMockTask({ status: 'PAUSED' });
    const project = createMockProject(task);

    mockedCreateSandbox.mockResolvedValue({
      createAndStart: vi
        .fn()
        .mockRejectedValue(new Error('Docker not available')),
    } as any);

    const result = await resumeTask(project, 1);

    expect(result).toBe(false);
    expect(task.markPaused).toHaveBeenCalledWith(
      'Resume failed: container could not start'
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

    expect(result).toBe(true);
    expect(task.markInProgress).toHaveBeenCalled();
  });
});
