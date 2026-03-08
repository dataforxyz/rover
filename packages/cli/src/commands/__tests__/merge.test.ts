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
  mockCollapseTaskCommits,
  mockGetAIAgentTool,
  mockGetUserDefaultModel,
  mockShowRoverChat,
  mockExecuteHooks,
  mockGenerateCommitMessage,
  mockResolveConflicts,
  mockGetTaskIterationSummaries,
} = vi.hoisted(() => ({
  mockRequireProjectContext: vi.fn(),
  mockSetJsonMode: vi.fn(),
  mockIsJsonMode: vi.fn().mockReturnValue(true),
  mockGetTelemetry: vi.fn(),
  mockExistsSync: vi.fn(),
  mockCollapseTaskCommits: vi.fn(),
  mockGetAIAgentTool: vi.fn(),
  mockGetUserDefaultModel: vi.fn(),
  mockShowRoverChat: vi.fn(),
  mockExecuteHooks: vi.fn(),
  mockGenerateCommitMessage: vi.fn(),
  mockResolveConflicts: vi.fn(),
  mockGetTaskIterationSummaries: vi.fn(),
}));

const mockGitInstance = vi.hoisted(() => ({
  isGitRepo: vi.fn(),
  getCurrentBranch: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  hasUnmergedCommits: vi.fn(),
  getRecentCommits: vi.fn(),
  addAndCommit: vi.fn(),
  mergeBranch: vi.fn(),
  getMergeConflicts: vi.fn(),
  abortMerge: vi.fn(),
  continueMerge: vi.fn(),
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
  showTips: vi.fn(),
}));

vi.mock('../../lib/hooks.js', () => ({
  executeHooks: mockExecuteHooks,
}));

vi.mock('../../lib/agents/index.js', () => ({
  getAIAgentTool: mockGetAIAgentTool,
  getUserDefaultModel: mockGetUserDefaultModel,
}));

vi.mock('../../lib/merge-rebase-utils.js', () => ({
  getTaskIterationSummaries: mockGetTaskIterationSummaries,
  generateCommitMessage: mockGenerateCommitMessage,
  resolveConflicts: mockResolveConflicts,
}));

vi.mock('../../lib/squash.js', () => ({
  collapseTaskCommits: mockCollapseTaskCommits,
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
  AI_AGENT: {
    Claude: 'claude',
  },
  Git: vi.fn(() => mockGitInstance),
  ProjectConfigManager: {
    load: vi.fn().mockReturnValue(null),
  },
  UserSettingsManager: {
    exists: vi.fn().mockReturnValue(false),
    load: vi.fn(),
  },
  showTitle: vi.fn(),
  showProperties: vi.fn(),
  showList: vi.fn(),
}));

import mergeCommandModule from '../merge.js';

describe('merge command', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetTelemetry.mockReturnValue({
      eventMergeTask: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    mockGetAIAgentTool.mockReturnValue({} as any);
    mockGetUserDefaultModel.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(true);

    mockGitInstance.isGitRepo.mockReturnValue(true);
    mockGitInstance.getCurrentBranch.mockReturnValue('main');
    mockGitInstance.hasUncommittedChanges
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    mockGitInstance.hasUnmergedCommits.mockReturnValue(true);
    mockGitInstance.getRecentCommits.mockReturnValue([]);
    mockGitInstance.addAndCommit.mockReturnValue(undefined);
    mockGitInstance.mergeBranch.mockReturnValue({ success: true });
    mockGitInstance.getMergeConflicts.mockReturnValue([]);

    const task = {
      id: 1,
      title: 'Test task',
      description: 'desc',
      branchName: 'task/1',
      worktreePath: '/tmp/task-1',
      status: 'COMPLETED',
      isPushed: () => false,
      isMerged: () => false,
      isInProgress: () => false,
      isIterating: () => false,
      isPaused: () => false,
      isCompleted: () => true,
      markMerged: vi.fn(),
      iterationsPath: vi.fn().mockReturnValue('/tmp/task-1/.rover/iterations'),
    };

    mockRequireProjectContext.mockResolvedValue({
      path: '/repo',
      getTask: vi.fn().mockReturnValue(task),
    });
  });

  it('merges without collapsing task branch commits first', async () => {
    await mergeCommandModule.action('1', { json: true, force: true });

    expect(mockCollapseTaskCommits).not.toHaveBeenCalled();
    expect(mockGitInstance.mergeBranch).toHaveBeenCalledWith(
      'task/1',
      'merge: Test task'
    );
    expect(mockExitWithSuccess).toHaveBeenCalledWith(
      'Task has been successfully merged into your current branch',
      expect.objectContaining({
        success: true,
        merged: true,
        hasWorktreeChanges: false,
        hasUnmergedCommits: true,
      }),
      expect.anything()
    );
  });
});
