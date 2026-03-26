import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../types.js';

const { mockTeardownServiceContainers, mockProjectConfigLoad } = vi.hoisted(
  () => ({
    mockTeardownServiceContainers: vi.fn(),
    mockProjectConfigLoad: vi.fn(),
  })
);

vi.mock('../service-containers.js', () => ({
  createServiceNetwork: vi.fn(),
  isServiceContainerContextAvailable: vi.fn(),
  startServiceContainers: vi.fn(),
  teardownServiceContainers: mockTeardownServiceContainers,
  waitForServicesReady: vi.fn(),
}));

vi.mock('rover-core', () => ({
  launch: vi.fn(),
  ProcessManager: class {},
  ProjectConfigManager: {
    load: mockProjectConfigLoad,
  },
  TaskDescriptionManager: class {},
}));

class TestSandbox extends Sandbox {
  backend = 'docker';

  async isBackendAvailable(): Promise<boolean> {
    return true;
  }

  async openShellAtWorktree(): Promise<{ exitCode?: number }> {
    return { exitCode: 0 };
  }

  async inspect(): Promise<{ status: string; exitCode?: number } | null> {
    return null;
  }

  protected async create(): Promise<string> {
    return 'created';
  }

  protected async start(): Promise<string> {
    return 'started';
  }

  protected async remove(): Promise<string> {
    return 'removed';
  }

  protected async stop(): Promise<string> {
    return 'stopped';
  }

  protected async logs(): Promise<string> {
    return '';
  }

  protected async *followLogs(): AsyncIterable<string> {}

  async runInteractive(): Promise<any> {
    return {};
  }

  async cleanupServicesForTest(): Promise<void> {
    await this.teardownServicesIfConfigured();
  }
}

describe('Sandbox service cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectConfigLoad.mockReturnValue({ services: [] });
  });

  it('tears down persisted services during stop on a fresh sandbox instance', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        projectPath: '/repo',
        sandboxMetadata: {
          serviceContext: {
            networkName: 'rover-services-12-3',
            containerNames: ['rover-svc-12-3-postgres', 'rover-svc-12-3-redis'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );

    await sandbox.stopAndRemove();

    expect(mockProjectConfigLoad).not.toHaveBeenCalled();
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres', 'rover-svc-12-3-redis'],
        taskId: 12,
        iteration: 3,
      },
      undefined
    );
  });

  it('skips teardown when no services are configured', async () => {
    mockProjectConfigLoad.mockReturnValue({ services: [] });

    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      { projectPath: '/repo' }
    );

    await sandbox.stopGracefully();

    expect(mockTeardownServiceContainers).not.toHaveBeenCalled();
  });

  it('forwards DOCKER_HOST when tearing down services', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        projectPath: '/repo',
        sandboxMetadata: {
          dockerHost: 'tcp://remote:2375',
          serviceContext: {
            networkName: 'rover-services-12-3',
            containerNames: ['rover-svc-12-3-postgres'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );

    await sandbox.stopGracefully();

    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      expect.objectContaining({
        networkName: 'rover-services-12-3',
      }),
      expect.objectContaining({
        DOCKER_HOST: 'tcp://remote:2375',
      })
    );
  });

  it('does not tear down services when stopGracefully fails to stop the task container', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        sandboxMetadata: {
          serviceContext: {
            networkName: 'rover-services-12-3',
            containerNames: ['rover-svc-12-3-postgres'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );
    vi.spyOn(sandbox as any, 'stop').mockRejectedValue(
      new Error('stop failed')
    );

    await sandbox.stopGracefully();

    expect(mockTeardownServiceContainers).not.toHaveBeenCalled();
    expect((sandbox as any).serviceContext).toBeUndefined();
    expect(sandbox.getSandboxMetadata()).toEqual({
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
      },
    });
  });

  it('does not tear down services when stopAndRemove fails to remove the task container', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        sandboxMetadata: {
          serviceContext: {
            networkName: 'rover-services-12-3',
            containerNames: ['rover-svc-12-3-postgres'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );
    vi.spyOn(sandbox as any, 'remove').mockRejectedValue(
      new Error('remove failed')
    );

    await sandbox.stopAndRemove();

    expect(mockTeardownServiceContainers).not.toHaveBeenCalled();
    expect(sandbox.getSandboxMetadata()).toEqual({
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
      },
    });
  });

  it('does not reconstruct service names from the current project config', async () => {
    mockProjectConfigLoad.mockReturnValue({
      services: [{ name: 'renamed-postgres' }],
    });

    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        projectPath: '/repo',
        sandboxMetadata: {
          serviceContext: {
            networkName: 'rover-services-12-3',
            containerNames: ['rover-svc-12-3-postgres'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );

    await sandbox.stopGracefully();

    expect(mockProjectConfigLoad).not.toHaveBeenCalled();
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      expect.objectContaining({
        containerNames: ['rover-svc-12-3-postgres'],
      }),
      undefined
    );
  });

  it('reuses an existing service context without reloading project config', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      { projectPath: '/repo' }
    );
    (sandbox as any).serviceContext = {
      networkName: 'rover-services-12-3',
      containerNames: ['rover-svc-12-3-postgres'],
      taskId: 12,
      iteration: 3,
    };

    await sandbox.cleanupServicesForTest();

    expect(mockProjectConfigLoad).not.toHaveBeenCalled();
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
      },
      undefined
    );
    expect((sandbox as any).serviceContext).toBeUndefined();
  });

  it('includes service context in persisted sandbox metadata', () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        sandboxMetadata: { dockerHost: 'tcp://remote:2375' },
      }
    );
    (sandbox as any).serviceContext = {
      networkName: 'rover-services-12-3',
      containerNames: ['rover-svc-12-3-postgres'],
      taskId: 12,
      iteration: 3,
    };

    expect(sandbox.getSandboxMetadata()).toEqual({
      dockerHost: 'tcp://remote:2375',
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
      },
    });
  });

  it('does not return persisted service context after teardown has run', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
        sandboxMetadata: {
          serviceContext: {
            networkName: 'rover-services-12-3',
            containerNames: ['rover-svc-12-3-postgres'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );

    await sandbox.teardownServices();

    expect(mockTeardownServiceContainers).toHaveBeenCalledTimes(1);
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });
});
