import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExitWithSuccess, mockExitWithError, mockExitWithWarn } = vi.hoisted(
  () => ({
    mockExitWithSuccess: vi.fn(),
    mockExitWithError: vi.fn(),
    mockExitWithWarn: vi.fn(),
  })
);

const {
  mockRequireProjectContext,
  mockSetJsonMode,
  mockIsJsonMode,
  mockGetTelemetry,
  mockExistsSync,
  mockExecuteHooks,
  mockCollapseTaskCommits,
  mockShowRoverChat,
  mockGetWorkspaceRepositories,
} = vi.hoisted(() => ({
  mockRequireProjectContext: vi.fn(),
  mockSetJsonMode: vi.fn(),
  mockIsJsonMode: vi.fn().mockReturnValue(true),
  mockGetTelemetry: vi.fn(),
  mockExistsSync: vi.fn(),
  mockExecuteHooks: vi.fn(),
  mockCollapseTaskCommits: vi.fn(),
  mockShowRoverChat: vi.fn(),
  mockGetWorkspaceRepositories: vi.fn(),
}));

const mockGitInstance = vi.hoisted(() => ({
  uncommittedChanges: vi.fn(),
  hasUnmergedCommits: vi.fn(),
  branchExists: vi.fn(),
  remoteBranchExists: vi.fn(),
  addAndCommit: vi.fn(),
  push: vi.fn(),
  remoteUrl: vi.fn(),
  checkoutBranch: vi.fn(),
  getCurrentBranch: vi.fn((options?: { worktreePath?: string }) =>
    options?.worktreePath === '/tmp/task-1/frontend' ? 'main' : 'task/1'
  ),
}));

vi.mock('../../utils/exit.js', () => ({
  exitWithError: mockExitWithError,
  exitWithSuccess: mockExitWithSuccess,
  exitWithWarn: mockExitWithWarn,
}));

vi.mock('../../lib/context.js', () => ({
  isJsonMode: mockIsJsonMode,
  setJsonMode: mockSetJsonMode,
  requireProjectContext: mockRequireProjectContext,
}));

vi.mock('../../lib/telemetry.js', () => ({
  getTelemetry: mockGetTelemetry,
}));

vi.mock('../../utils/display.js', () => ({
  showRoverChat: mockShowRoverChat,
  TIP_TITLES: {
    NEXT_STEPS: 'Next Steps',
  },
}));

vi.mock('../../utils/task-status.js', () => ({
  statusColor: vi.fn().mockReturnValue((status: string) => status),
}));

vi.mock('../../lib/hooks.js', () => ({
  executeHooks: mockExecuteHooks,
}));

vi.mock('../../lib/squash.js', () => ({
  collapseTaskCommits: mockCollapseTaskCommits,
}));

vi.mock('../../lib/workspace-repositories.js', () => ({
  getWorkspaceRepositories: mockGetWorkspaceRepositories,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

vi.mock('yocto-spinner', () => ({
  default: vi.fn(),
}));

vi.mock('enquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

vi.mock('rover-core', () => ({
  ProjectConfigManager: {
    load: vi.fn().mockReturnValue({
      hooks: undefined,
      projects: [],
    }),
  },
  Git: vi.fn(() => mockGitInstance),
  showTitle: vi.fn(),
  showProperties: vi.fn(),
}));

import pushCommandModule from '../push.js';

describe('push command', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetTelemetry.mockReturnValue({
      eventPushBranch: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

    mockExistsSync.mockReturnValue(true);
    mockGitInstance.uncommittedChanges.mockReturnValue([]);
    mockGitInstance.hasUnmergedCommits.mockReturnValue(true);
    mockGitInstance.branchExists.mockReturnValue(true);
    mockGitInstance.remoteBranchExists.mockReturnValue(true);
    mockGitInstance.addAndCommit.mockReturnValue(undefined);
    mockGitInstance.push.mockReturnValue(undefined);
    mockGitInstance.remoteUrl.mockReturnValue('');
    mockGetWorkspaceRepositories.mockReturnValue([]);

    const task = {
      id: 1,
      title: 'Test task',
      branchName: 'task/1',
      baseCommit: 'abc123',
      worktreePath: '/tmp/task-1',
      getBasePath: () => '/tmp/tasks/1',
      status: 'COMPLETED',
      isInProgress: () => false,
      isIterating: () => false,
      isPaused: () => false,
      markPushed: vi.fn(),
    };

    mockRequireProjectContext.mockResolvedValue({
      path: '/repo',
      getTask: vi.fn().mockReturnValue(task),
    });
  });

  it('pushes an existing branch without collapsing local commits', async () => {
    await pushCommandModule.action('1', { json: true });

    expect(mockCollapseTaskCommits).not.toHaveBeenCalled();
    expect(mockGitInstance.push).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockExitWithSuccess).toHaveBeenCalledWith(
      'Push completed successfully!',
      expect.objectContaining({
        success: true,
        pushed: true,
        committed: false,
      }),
      expect.anything()
    );
  });

  it('pushes configured workspace repositories alongside the root workspace', async () => {
    mockGetWorkspaceRepositories.mockReturnValue([
      {
        name: 'frontend',
        relativePath: 'frontend',
        worktreePath: '/tmp/task-1/frontend',
        repository: 'https://example.com/frontend.git',
      },
    ]);
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend' ? 'main' : 'task/1'
    );
    mockGitInstance.uncommittedChanges.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend'
          ? [' M src/app.ts']
          : []
    );
    mockGitInstance.hasUnmergedCommits.mockImplementation(
      (_branchName, options?: { worktreePath?: string }) =>
        options?.worktreePath !== '/tmp/task-1/frontend'
    );
    mockGitInstance.branchExists.mockImplementation(
      (_branchName, options?: { worktreePath?: string }) =>
        options?.worktreePath !== '/tmp/task-1/frontend'
    );
    mockGitInstance.remoteBranchExists.mockImplementation(
      (_branchName, _remoteName, options?: { worktreePath?: string }) =>
        options?.worktreePath !== '/tmp/task-1/frontend'
    );

    await pushCommandModule.action('1', { json: true });

    expect(mockGitInstance.push).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockGitInstance.checkoutBranch).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
      createIfMissing: true,
    });
    expect(mockGitInstance.push).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
    });
  });

  it('does not create or push task branches for untouched workspace repositories without upstream branches', async () => {
    mockGetWorkspaceRepositories.mockReturnValue([
      {
        name: 'frontend',
        relativePath: 'frontend',
        worktreePath: '/tmp/task-1/frontend',
        repository: 'https://example.com/frontend.git',
      },
    ]);
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend' ? 'main' : 'task/1'
    );
    mockGitInstance.uncommittedChanges.mockReturnValue([]);
    mockGitInstance.hasUnmergedCommits.mockImplementation(
      (
        _branchName,
        options?: { worktreePath?: string; targetBranch?: string }
      ) => options?.worktreePath === '/tmp/task-1'
    );
    mockGitInstance.branchExists.mockImplementation(
      (_branchName, options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1'
    );
    mockGitInstance.remoteBranchExists.mockImplementation(
      (_branchName, _remoteName, options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1'
    );

    await pushCommandModule.action('1', { json: true });

    expect(mockGitInstance.checkoutBranch).not.toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
      createIfMissing: true,
    });
    expect(mockGitInstance.push).not.toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
    });
    expect(mockGitInstance.push).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1',
    });
  });

  it('pushes workspace repositories with local task commits even when the upstream branch does not exist yet', async () => {
    mockGetWorkspaceRepositories.mockReturnValue([
      {
        name: 'frontend',
        relativePath: 'frontend',
        worktreePath: '/tmp/task-1/frontend',
        repository: 'https://example.com/frontend.git',
      },
    ]);
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend' ? 'main' : 'task/1'
    );
    mockGitInstance.uncommittedChanges.mockReturnValue([]);
    mockGitInstance.branchExists.mockImplementation(
      (_branchName, options?: { worktreePath?: string }) => true
    );
    mockGitInstance.remoteBranchExists.mockImplementation(
      (_branchName, _remoteName, options?: { worktreePath?: string }) =>
        options?.worktreePath !== '/tmp/task-1/frontend'
    );
    mockGitInstance.hasUnmergedCommits.mockImplementation(
      (
        _branchName,
        options?: { targetBranch?: string; worktreePath?: string }
      ) =>
        options?.worktreePath === '/tmp/task-1/frontend' &&
        options?.targetBranch === 'main'
    );

    await pushCommandModule.action('1', { json: true });

    expect(mockGitInstance.checkoutBranch).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
      createIfMissing: true,
    });
    expect(mockGitInstance.push).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
    });
  });

  it('fails when a configured workspace repository is missing from the task workspace', async () => {
    mockGetWorkspaceRepositories.mockReturnValue([
      {
        name: 'frontend',
        relativePath: 'frontend',
        worktreePath: '/tmp/task-1/frontend',
        repository: 'https://example.com/frontend.git',
      },
    ]);
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath === '/tmp/task-1/frontend') {
        return false;
      }
      return true;
    });

    await pushCommandModule.action('1', { json: true });

    expect(mockGitInstance.push).not.toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
    });
    expect(mockExitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          'Configured workspace repositories are missing or invalid: frontend (frontend)',
      }),
      expect.anything()
    );
  });
});
