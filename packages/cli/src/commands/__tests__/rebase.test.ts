import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePathWithinRoot } from '../../utils/path-safety.js';

const {
  mockExitWithError,
  mockExitWithSuccess,
  mockGetTelemetry,
  mockRequireProjectContext,
  mockGetWorkspaceRepositoriesLookupResult,
  mockGetAIAgentTool,
  mockRepoGitInstance,
  mockLaunchSync,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockExitWithError: vi.fn(),
  mockExitWithSuccess: vi.fn(),
  mockGetTelemetry: vi.fn(),
  mockRequireProjectContext: vi.fn(),
  mockGetWorkspaceRepositoriesLookupResult: vi.fn(),
  mockGetAIAgentTool: vi.fn(),
  mockRepoGitInstance: {
    getMainBranch: vi.fn().mockReturnValue('develop'),
    remoteBranchExists: vi.fn().mockReturnValue(true),
  },
  mockLaunchSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

const mockGitInstance = vi.hoisted(() => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getCurrentBranch: vi.fn((options?: { worktreePath?: string }): string =>
    options?.worktreePath === '/tmp/task-1/frontend' ? 'main' : 'task/1'
  ),
  getMainBranch: vi.fn().mockReturnValue('main'),
  hasUncommittedChanges: vi.fn().mockReturnValue(false),
  getRecentCommits: vi.fn().mockReturnValue([]),
  rebaseBranch: vi.fn().mockReturnValue({ success: true }),
  getMergeConflicts: vi.fn().mockReturnValue([]),
  getCommitHash: vi.fn().mockReturnValue('new-base'),
  checkoutBranch: vi.fn(),
}));

vi.mock('../../utils/exit.js', () => ({
  exitWithError: mockExitWithError,
  exitWithSuccess: mockExitWithSuccess,
  exitWithWarn: vi.fn(),
}));

vi.mock('../../lib/telemetry.js', () => ({
  getTelemetry: mockGetTelemetry,
}));

vi.mock('../../lib/context.js', () => ({
  isJsonMode: vi.fn().mockReturnValue(true),
  setJsonMode: vi.fn(),
  requireProjectContext: mockRequireProjectContext,
}));

vi.mock('../../utils/display.js', () => ({
  showRoverChat: vi.fn(),
}));

vi.mock('enquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

vi.mock('yocto-spinner', () => ({
  default: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

vi.mock('rover-core', () => ({
  AI_AGENT: {
    Claude: 'claude',
  },
  Git: vi.fn(({ cwd }: { cwd: string }) =>
    cwd === '/tmp/task-1/frontend' ? mockRepoGitInstance : mockGitInstance
  ),
  launchSync: mockLaunchSync,
  ProjectConfigManager: {
    load: vi.fn().mockReturnValue({
      attribution: true,
      projects: [],
    }),
  },
  UserSettingsManager: {
    exists: vi.fn().mockReturnValue(false),
    load: vi.fn(),
  },
}));

vi.mock('../../lib/agents/index.js', () => ({
  getAIAgentTool: mockGetAIAgentTool,
  getUserDefaultModel: vi.fn(),
}));

vi.mock('../../lib/squash.js', () => ({
  collapseTaskCommits: vi.fn(),
}));

vi.mock('../../lib/context-optimizer.js', () => ({
  truncateConflictContext: vi.fn(),
  getBlameContext: vi.fn(),
  parseResolvedRegions: vi.fn(),
  reconstructFile: vi.fn(),
  sanitizeAIOutput: vi.fn(),
  hasConflictMarkers: vi.fn(),
}));

vi.mock('../../lib/workspace-repositories.js', () => ({
  getWorkspaceRepositoriesLookupResult:
    mockGetWorkspaceRepositoriesLookupResult,
}));

import { rebaseCommand } from '../rebase.js';

describe('rebase command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetry.mockReturnValue({
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    mockExitWithError.mockResolvedValue(undefined);
    mockExitWithSuccess.mockResolvedValue(undefined);
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: false,
      hasPersistedParseErrors: false,
      repositories: [],
    });
    mockGetAIAgentTool.mockReturnValue({});
    mockRepoGitInstance.getMainBranch.mockClear();
    mockRepoGitInstance.getMainBranch.mockReturnValue('develop');
    mockRepoGitInstance.remoteBranchExists.mockClear();
    mockRepoGitInstance.remoteBranchExists.mockReturnValue(true);
    mockLaunchSync.mockReset();
    mockLaunchSync.mockReturnValue({ exitCode: 0, stdout: '' });
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.isGitRepo.mockReturnValue(true);
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }): string =>
        options?.worktreePath === '/tmp/task-1/frontend' ? 'main' : 'task/1'
    );
    mockGitInstance.getMainBranch.mockReturnValue('main');
    mockGitInstance.hasUncommittedChanges.mockReturnValue(false);
    mockGitInstance.getRecentCommits.mockReturnValue([]);
    mockGitInstance.rebaseBranch.mockReturnValue({ success: true });
    mockGitInstance.getMergeConflicts.mockReturnValue([]);
    mockGitInstance.getCommitHash.mockReturnValue('new-base');
    mockRequireProjectContext.mockResolvedValue({
      path: '/repo',
      getTask: vi.fn().mockReturnValue({
        id: 1,
        title: 'Test task',
        description: 'test',
        branchName: 'task/1',
        baseCommit: 'base',
        worktreePath: '/tmp/task-1',
        getBasePath: () => '/tmp/tasks/1',
        status: 'COMPLETED',
        iterations: 1,
        isInProgress: () => false,
        isIterating: () => false,
        isPaused: () => false,
        iterationsPath: () => '/tmp/task-1/.rover/iterations',
        setBaseCommit: vi.fn(),
      }),
    });
    Object.values(mockGitInstance).forEach(value => {
      if (typeof value === 'function' && 'mockClear' in value) {
        value.mockClear();
      }
    });
  });

  it('rejects malformed numeric task IDs with trailing characters', async () => {
    await rebaseCommand('12abc', { json: true });

    expect(mockExitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "Invalid task ID '12abc' - must be a number",
      }),
      expect.objectContaining({ telemetry: expect.anything() })
    );
  });

  it('fails with a clear error when rebasing from a detached checkout without --base', async () => {
    mockGitInstance.getCurrentBranch.mockReturnValue('unknown');

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockGitInstance.rebaseBranch).not.toHaveBeenCalled();
    expect(mockExitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        currentBranch: 'unknown',
        error:
          'Current checkout is detached. Pass `--base <branch>` or check out a branch before rebasing.',
      }),
      expect.objectContaining({ telemetry: expect.anything() })
    );
  });

  it('accepts paths under the root with Windows separators', () => {
    expect(
      resolvePathWithinRoot(
        'C:\\repo',
        'src\\conflicted.ts',
        path.win32 as typeof path
      )
    ).toBe('C:\\repo\\src\\conflicted.ts');
  });

  it('rejects traversal outside the root with Windows separators', () => {
    expect(
      resolvePathWithinRoot(
        'C:\\repo',
        '..\\outside.ts',
        path.win32 as typeof path
      )
    ).toBeNull();
  });

  it('rebases configured workspace repositories onto the requested base branch', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: false,
      hasPersistedParseErrors: false,
      repositories: [
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: '/tmp/task-1/frontend',
          repository: 'https://example.com/frontend.git',
          ref: 'main',
        },
      ],
    });

    await rebaseCommand('1', {
      json: true,
      force: true,
      base: 'release/x',
    });

    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('release/x', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockGitInstance.checkoutBranch).toHaveBeenCalledWith('task/1', {
      worktreePath: '/tmp/task-1/frontend',
      createIfMissing: true,
    });
    expect(mockLaunchSync).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/task-1/frontend',
      'fetch',
      'origin',
      'release/x',
    ]);
    expect(mockRepoGitInstance.remoteBranchExists).toHaveBeenCalledWith(
      'release/x',
      'origin',
      expect.objectContaining({
        refresh: true,
      })
    );
    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith(
      'origin/release/x',
      {
        worktreePath: '/tmp/task-1/frontend',
      }
    );
    expect(mockExitWithSuccess).toHaveBeenCalled();
  });

  it('rebases each workspace repository onto its configured ref by default', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: false,
      hasPersistedParseErrors: false,
      repositories: [
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: '/tmp/task-1/frontend',
          repository: 'https://example.com/frontend.git',
          ref: 'release/1.0',
        },
      ],
    });
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend' ? 'task/1' : 'main'
    );

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('main', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockLaunchSync).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/task-1/frontend',
      'fetch',
      'origin',
      'release/1.0',
    ]);
    expect(mockRepoGitInstance.remoteBranchExists).toHaveBeenCalledWith(
      'release/1.0',
      'origin',
      expect.objectContaining({
        refresh: true,
      })
    );
    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith(
      'origin/release/1.0',
      {
        worktreePath: '/tmp/task-1/frontend',
      }
    );
    expect(mockExitWithSuccess).toHaveBeenCalled();
  });

  it('rebases workspace repositories without refs onto their own default branch', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: false,
      hasPersistedParseErrors: false,
      repositories: [
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: '/tmp/task-1/frontend',
          repository: 'https://example.com/frontend.git',
        },
      ],
    });
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend'
          ? 'task/1'
          : 'release/root'
    );
    mockRepoGitInstance.getMainBranch.mockReturnValue('develop');

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('release/root', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockRepoGitInstance.getMainBranch).toHaveBeenCalled();
    expect(mockLaunchSync).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/task-1/frontend',
      'fetch',
      'origin',
      'develop',
    ]);
    expect(mockRepoGitInstance.remoteBranchExists).toHaveBeenCalledWith(
      'develop',
      'origin',
      expect.objectContaining({
        refresh: true,
      })
    );
    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith(
      'origin/develop',
      {
        worktreePath: '/tmp/task-1/frontend',
      }
    );
    expect(mockExitWithSuccess).toHaveBeenCalled();
  });

  it('falls back to the local base branch when refresh shows the remote base ref is stale', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: false,
      hasPersistedParseErrors: false,
      repositories: [
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: '/tmp/task-1/frontend',
          repository: 'https://example.com/frontend.git',
          ref: 'develop',
        },
      ],
    });
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend' ? 'task/1' : 'main'
    );
    mockRepoGitInstance.remoteBranchExists.mockImplementation(
      (branchName, _remoteName, options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend'
          ? branchName === 'task/1'
          : false
    );

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockRepoGitInstance.remoteBranchExists).toHaveBeenCalledWith(
      'develop',
      'origin',
      expect.objectContaining({
        refresh: true,
      })
    );
    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('develop', {
      worktreePath: '/tmp/task-1/frontend',
    });
    expect(mockGitInstance.rebaseBranch).not.toHaveBeenCalledWith(
      'origin/develop',
      {
        worktreePath: '/tmp/task-1/frontend',
      }
    );
  });

  it('skips configured workspace repositories that have not been cloned yet', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: false,
      hasPersistedParseErrors: false,
      repositories: [
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: '/tmp/task-1/frontend',
          repository: 'https://example.com/frontend.git',
        },
      ],
    });
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath === '/tmp/task-1/frontend') {
        return false;
      }
      return true;
    });
    mockGitInstance.getCurrentBranch.mockImplementation(
      (options?: { worktreePath?: string }) =>
        options?.worktreePath === '/tmp/task-1/frontend'
          ? 'task/1'
          : 'release/root'
    );

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockExitWithError).not.toHaveBeenCalled();
    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('release/root', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockGitInstance.rebaseBranch).not.toHaveBeenCalledWith(
      expect.any(String),
      {
        worktreePath: '/tmp/task-1/frontend',
      }
    );
  });

  it('fails when a persisted workspace repository is missing from the task workspace', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: true,
      hasPersistedParseErrors: false,
      repositories: [
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: '/tmp/task-1/frontend',
          repository: 'https://example.com/frontend.git',
        },
      ],
    });
    mockExistsSync.mockImplementation((targetPath: string) => {
      if (targetPath === '/tmp/task-1/frontend') {
        return false;
      }
      return true;
    });

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockGitInstance.rebaseBranch).not.toHaveBeenCalledWith(
      expect.any(String),
      {
        worktreePath: '/tmp/task-1/frontend',
      }
    );
    expect(mockExitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          'Configured workspace repositories are missing or invalid: frontend (frontend)',
      }),
      expect.anything()
    );
  });

  it('fails closed when persisted workspace repository metadata is malformed', async () => {
    mockGetWorkspaceRepositoriesLookupResult.mockReturnValue({
      foundPersistedState: true,
      hasPersistedParseErrors: true,
      repositories: [],
    });

    await rebaseCommand('1', {
      json: true,
      force: true,
    });

    expect(mockGitInstance.rebaseBranch).not.toHaveBeenCalled();
    expect(mockExitWithError).toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          'Persisted workspace repository metadata is invalid. Fix or remove the task workspace description before rebasing.',
      }),
      expect.anything()
    );
  });
});
