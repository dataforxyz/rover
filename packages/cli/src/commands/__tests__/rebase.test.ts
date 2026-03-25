import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolvePathWithinRoot } from '../../utils/path-safety.js';

const {
  mockExitWithError,
  mockExitWithSuccess,
  mockGetTelemetry,
  mockRequireProjectContext,
  mockGetWorkspaceRepositories,
  mockGetAIAgentTool,
} = vi.hoisted(() => ({
  mockExitWithError: vi.fn(),
  mockExitWithSuccess: vi.fn(),
  mockGetTelemetry: vi.fn(),
  mockRequireProjectContext: vi.fn(),
  mockGetWorkspaceRepositories: vi.fn(),
  mockGetAIAgentTool: vi.fn(),
}));

const mockGitInstance = vi.hoisted(() => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  hasUncommittedChanges: vi.fn().mockReturnValue(false),
  getRecentCommits: vi.fn().mockReturnValue([]),
  rebaseBranch: vi.fn().mockReturnValue({ success: true }),
  getMergeConflicts: vi.fn().mockReturnValue([]),
  getCommitHash: vi.fn().mockReturnValue('new-base'),
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
    existsSync: vi.fn().mockReturnValue(true),
  };
});

vi.mock('rover-core', () => ({
  AI_AGENT: {
    Claude: 'claude',
  },
  Git: vi.fn(() => mockGitInstance),
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
  getWorkspaceRepositories: mockGetWorkspaceRepositories,
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
    mockGetWorkspaceRepositories.mockReturnValue([]);
    mockGetAIAgentTool.mockReturnValue({});
    mockRequireProjectContext.mockResolvedValue({
      path: '/repo',
      getTask: vi.fn().mockReturnValue({
        id: 1,
        title: 'Test task',
        description: 'test',
        branchName: 'task/1',
        baseCommit: 'base',
        worktreePath: '/tmp/task-1',
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

  it('rebases configured workspace repositories after the root workspace', async () => {
    mockGetWorkspaceRepositories.mockReturnValue([
      {
        name: 'frontend',
        relativePath: 'frontend',
        worktreePath: '/tmp/task-1/frontend',
        repository: 'https://example.com/frontend.git',
        ref: 'main',
      },
    ]);

    await rebaseCommand('1', { json: true, force: true });

    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('main', {
      worktreePath: '/tmp/task-1',
    });
    expect(mockGitInstance.rebaseBranch).toHaveBeenCalledWith('main', {
      worktreePath: '/tmp/task-1/frontend',
    });
    expect(mockExitWithSuccess).toHaveBeenCalled();
  });
});
