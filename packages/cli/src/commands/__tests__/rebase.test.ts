import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolvePathWithinRoot } from '../../utils/path-safety.js';

const { mockExitWithError, mockGetTelemetry } = vi.hoisted(() => ({
  mockExitWithError: vi.fn(),
  mockGetTelemetry: vi.fn(),
}));

vi.mock('../../utils/exit.js', () => ({
  exitWithError: mockExitWithError,
  exitWithSuccess: vi.fn(),
  exitWithWarn: vi.fn(),
}));

vi.mock('../../lib/telemetry.js', () => ({
  getTelemetry: mockGetTelemetry,
}));

vi.mock('../../lib/context.js', () => ({
  isJsonMode: vi.fn().mockReturnValue(true),
  setJsonMode: vi.fn(),
  requireProjectContext: vi.fn(),
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

vi.mock('rover-core', () => ({
  AI_AGENT: {
    Claude: 'claude',
  },
  Git: vi.fn(),
  ProjectConfigManager: {
    load: vi.fn(),
  },
  UserSettingsManager: {
    exists: vi.fn().mockReturnValue(false),
    load: vi.fn(),
  },
}));

vi.mock('../../lib/agents/index.js', () => ({
  getAIAgentTool: vi.fn(),
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

import { rebaseCommand } from '../rebase.js';

describe('rebase command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetry.mockReturnValue({
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    mockExitWithError.mockResolvedValue(undefined);
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
});
