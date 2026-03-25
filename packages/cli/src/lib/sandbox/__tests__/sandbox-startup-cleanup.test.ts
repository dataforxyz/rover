import { beforeEach, describe, expect, it, vi } from 'vitest';
const {
  mockCreateServiceNetwork,
  mockStartServiceContainers,
  mockWaitForServicesReady,
  mockTeardownServiceContainers,
  mockProjectConfigLoad,
} = vi.hoisted(() => ({
  mockCreateServiceNetwork: vi.fn(),
  mockStartServiceContainers: vi.fn(),
  mockWaitForServicesReady: vi.fn(),
  mockTeardownServiceContainers: vi.fn(),
  mockProjectConfigLoad: vi.fn(),
}));

vi.mock('../service-containers.js', () => ({
  createServiceNetwork: mockCreateServiceNetwork,
  getServiceNetworkArgs: vi.fn(() => []),
  startServiceContainers: mockStartServiceContainers,
  teardownServiceContainers: mockTeardownServiceContainers,
  waitForServicesReady: mockWaitForServicesReady,
}));

vi.mock('rover-core', async () => {
  const actual =
    await vi.importActual<typeof import('rover-core')>('rover-core');
  return {
    ...actual,
    ProjectConfigManager: {
      ...actual.ProjectConfigManager,
      load: mockProjectConfigLoad,
    },
  };
});

import { DockerSandbox } from '../docker.js';
import { PodmanSandbox } from '../podman.js';

function createFakeTask() {
  return {
    id: 1,
    iterations: 1,
  } as any;
}

describe('sandbox startup cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectConfigLoad.mockReturnValue({ services: [] });
  });

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

  it('tears down Docker service containers when task container startup fails', async () => {
    mockProjectConfigLoad.mockReturnValue({ services: [{ name: 'postgres' }] });
    mockCreateServiceNetwork.mockResolvedValue('rover-services-1-1');
    mockStartServiceContainers.mockResolvedValue(['rover-svc-1-1-postgres']);
    mockWaitForServicesReady.mockResolvedValue(undefined);

    const sandbox = new DockerSandbox(createFakeTask(), undefined, {
      projectPath: '/repo',
    });

    (sandbox as any).checkCacheState = vi.fn().mockImplementation(() => {
      (sandbox as any).shouldCommitCache = false;
    });
    (sandbox as any).create = vi
      .fn()
      .mockRejectedValue(new Error('docker create failed'));

    await expect(sandbox.createAndStart()).rejects.toThrow(
      'docker create failed'
    );
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
      expect.any(Object)
    );
    expect((sandbox as any).serviceContext).toBeUndefined();
  });

  it('tears down Podman service containers when task container startup fails', async () => {
    mockProjectConfigLoad.mockReturnValue({ services: [{ name: 'postgres' }] });
    mockCreateServiceNetwork.mockResolvedValue('rover-services-1-1');
    mockStartServiceContainers.mockResolvedValue(['rover-svc-1-1-postgres']);
    mockWaitForServicesReady.mockResolvedValue(undefined);

    const sandbox = new PodmanSandbox(createFakeTask(), undefined, {
      projectPath: '/repo',
    });

    (sandbox as any).checkCacheState = vi.fn().mockImplementation(() => {
      (sandbox as any).shouldCommitCache = false;
    });
    (sandbox as any).create = vi
      .fn()
      .mockRejectedValue(new Error('podman create failed'));

    await expect(sandbox.createAndStart()).rejects.toThrow(
      'podman create failed'
    );
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith('podman', {
      networkName: 'rover-services-1-1',
      containerNames: ['rover-svc-1-1-postgres'],
      taskId: 1,
      iteration: 1,
    });
    expect((sandbox as any).serviceContext).toBeUndefined();
  });

  it('tears down a Docker service network if startup fails before containers are recorded', async () => {
    mockProjectConfigLoad.mockReturnValue({ services: [{ name: 'postgres' }] });
    mockCreateServiceNetwork.mockResolvedValue('rover-services-1-1');
    mockStartServiceContainers.mockRejectedValue(
      new Error('service startup failed')
    );

    const sandbox = new DockerSandbox(createFakeTask(), undefined, {
      projectPath: '/repo',
    });

    (sandbox as any).checkCacheState = vi.fn().mockImplementation(() => {
      (sandbox as any).shouldCommitCache = false;
    });

    await expect(sandbox.createAndStart()).rejects.toThrow(
      'service startup failed'
    );
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      {
        networkName: 'rover-services-1-1',
        containerNames: [],
        taskId: 1,
        iteration: 1,
      },
      expect.any(Object)
    );
  });

  it('preserves the original Docker service startup error when teardown also fails', async () => {
    mockProjectConfigLoad.mockReturnValue({ services: [{ name: 'postgres' }] });
    mockCreateServiceNetwork.mockResolvedValue('rover-services-1-1');
    mockStartServiceContainers.mockRejectedValue(
      new Error('service startup failed')
    );
    mockTeardownServiceContainers.mockRejectedValue(
      new Error('cleanup failed')
    );

    const sandbox = new DockerSandbox(createFakeTask(), undefined, {
      projectPath: '/repo',
    });

    (sandbox as any).checkCacheState = vi.fn().mockImplementation(() => {
      (sandbox as any).shouldCommitCache = false;
    });

    await expect(sandbox.createAndStart()).rejects.toThrow(
      'service startup failed'
    );
  });
});
