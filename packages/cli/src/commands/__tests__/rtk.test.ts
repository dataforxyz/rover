import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testConfigDir: string;

vi.mock('rover-core', async () => {
  const actual = await vi.importActual<typeof import('rover-core')>('rover-core');
  return {
    ...actual,
    getConfigDir: vi.fn(() => testConfigDir),
  };
});

vi.mock('../../lib/context.js', () => ({
  isJsonMode: vi.fn(() => false),
}));

describe('rtk commands', () => {
  beforeEach(() => {
    testConfigDir = mkdtempSync(join(tmpdir(), 'rover-rtk-'));
    delete process.env.ROVER_RTK;
  });

  afterEach(() => {
    rmSync(testConfigDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes disabled config', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { disableRtkCommand } = await import('../rtk/disable.js');

    await disableRtkCommand();

    expect(
      JSON.parse(readFileSync(join(testConfigDir, 'rtk.json'), 'utf8'))
    ).toEqual({ enabled: false });
    expect(spy).toHaveBeenCalledWith(
      'RTK disabled by default for rover tasks.'
    );
  });

  it('writes enabled config', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { enableRtkCommand } = await import('../rtk/enable.js');

    await enableRtkCommand();

    expect(
      JSON.parse(readFileSync(join(testConfigDir, 'rtk.json'), 'utf8'))
    ).toEqual({ enabled: true });
    expect(spy).toHaveBeenCalledWith(
      'RTK enabled by default for rover tasks.'
    );
  });
});
