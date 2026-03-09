import { describe, expect, it, vi } from 'vitest';
import { DockerSandbox } from '../docker.js';
import { PodmanSandbox } from '../podman.js';

function createFakeTask() {
  return {
    id: 1,
    iterations: 1,
  } as any;
}

describe('sandbox startup cleanup', () => {
  it('cleans temporary files when Docker startup fails', async () => {
    const sandbox = new DockerSandbox(createFakeTask());
    const cleanup = vi.fn();

    (sandbox as any).checkCacheState = vi.fn().mockImplementation(() => {
      (sandbox as any).shouldCommitCache = false;
    });
    (sandbox as any)._tmpCleanups = [cleanup];
    (sandbox as any).create = vi
      .fn()
      .mockRejectedValue(new Error('docker create failed'));

    await expect(sandbox.createAndStart()).rejects.toThrow(
      'docker create failed'
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((sandbox as any)._tmpCleanups).toEqual([]);
  });

  it('cleans temporary files when Podman startup fails', async () => {
    const sandbox = new PodmanSandbox(createFakeTask());
    const cleanup = vi.fn();

    (sandbox as any).checkCacheState = vi.fn().mockImplementation(() => {
      (sandbox as any).shouldCommitCache = false;
    });
    (sandbox as any)._tmpCleanups = [cleanup];
    (sandbox as any).create = vi
      .fn()
      .mockRejectedValue(new Error('podman create failed'));

    await expect(sandbox.createAndStart()).rejects.toThrow(
      'podman create failed'
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((sandbox as any)._tmpCleanups).toEqual([]);
  });
});
