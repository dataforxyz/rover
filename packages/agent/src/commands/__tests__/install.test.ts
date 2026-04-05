import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installCommand } from '../install.js';

const validateCredentials = vi.fn();
const install = vi.fn();
const copyCredentials = vi.fn();

vi.mock('../../lib/agents/index.js', () => ({
  createAgent: vi.fn(() => ({
    validateCredentials,
    install,
    copyCredentials,
  })),
}));

describe('installCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    validateCredentials.mockReset();
    install.mockReset();
    copyCredentials.mockReset();
  });

  it('sets a non-zero exit code when credential validation fails', async () => {
    validateCredentials.mockReturnValue({
      valid: false,
      missing: ['/.claude.json (Claude configuration)'],
    });

    await installCommand('claude');

    expect(process.exitCode).toBe(1);
    expect(install).not.toHaveBeenCalled();
    expect(copyCredentials).not.toHaveBeenCalled();
  });

  it('leaves exit code unset on successful install', async () => {
    validateCredentials.mockReturnValue({
      valid: true,
      missing: [],
    });

    await installCommand('claude');

    expect(process.exitCode).toBeUndefined();
    expect(install).toHaveBeenCalledOnce();
    expect(copyCredentials).toHaveBeenCalledOnce();
  });
});
