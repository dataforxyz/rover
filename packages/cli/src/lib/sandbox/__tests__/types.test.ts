import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../types.js';

const {
  mockCreateServiceNetwork,
  mockHasAnyServiceContainerResources,
  mockIsServiceContainerContextAvailable,
  mockStartServiceContainers,
  mockTeardownServiceContainers,
  mockWaitForServicesReady,
  mockProjectConfigLoad,
} = vi.hoisted(() => ({
  mockCreateServiceNetwork: vi.fn(),
  mockHasAnyServiceContainerResources: vi.fn(),
  mockIsServiceContainerContextAvailable: vi.fn(),
  mockStartServiceContainers: vi.fn(),
  mockTeardownServiceContainers: vi.fn(),
  mockWaitForServicesReady: vi.fn(),
  mockProjectConfigLoad: vi.fn(),
}));

function hashServices(services: unknown): string {
  const stableSerialize = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map(item => stableSerialize(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right)
      );
      return `{${entries
        .map(
          ([key, nestedValue]) =>
            `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`
        )
        .join(',')}}`;
    }

    return JSON.stringify(value);
  };

  return createHash('sha256').update(stableSerialize(services)).digest('hex');
}

vi.mock('../service-containers.js', () => ({
  buildServiceContainerContext: vi.fn((services, taskId, iteration) => ({
    networkName: `rover-services-${taskId}-${iteration}`,
    containerNames: services.map(
      (service: { name: string }) =>
        `rover-svc-${taskId}-${iteration}-${service.name}`
    ),
    taskId,
    iteration,
  })),
  createServiceNetwork: mockCreateServiceNetwork,
  hasAnyServiceContainerResources: mockHasAnyServiceContainerResources,
  isServiceContainerContextAvailable: mockIsServiceContainerContextAvailable,
  startServiceContainers: mockStartServiceContainers,
  teardownServiceContainers: mockTeardownServiceContainers,
  waitForServicesReady: mockWaitForServicesReady,
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

  async ensureServicesForTest(services: any): Promise<any> {
    return await this.ensureServiceContext(services);
  }
}

describe('Sandbox service cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectConfigLoad.mockReturnValue({ services: [] });
    mockCreateServiceNetwork.mockResolvedValue('rover-services-12-3');
    mockHasAnyServiceContainerResources.mockResolvedValue(false);
    mockIsServiceContainerContextAvailable.mockResolvedValue(false);
    mockStartServiceContainers.mockResolvedValue(['rover-svc-12-3-postgres']);
    mockWaitForServicesReady.mockResolvedValue(undefined);
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

  it('does not tear down services on graceful stop used for pause flows', async () => {
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

    expect(mockTeardownServiceContainers).not.toHaveBeenCalled();
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

  it('does not tear down services when stopGracefully finds the task container already missing', async () => {
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
      new Error('Error: No such object: rover-task-12-3')
    );

    await sandbox.stopGracefully();

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

  it('does not tear down services when stopGracefully fails for a non-missing container error', async () => {
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

    await expect(sandbox.stopGracefully()).rejects.toThrow('stop failed');

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

  it('tears down services when stopAndRemove finds the task container already missing', async () => {
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
      new Error('Error: No such object: rover-task-12-3')
    );
    vi.spyOn(sandbox as any, 'remove').mockRejectedValue(
      new Error('Error: No such object: rover-task-12-3')
    );

    await sandbox.stopAndRemove();

    expect(mockTeardownServiceContainers).toHaveBeenCalledTimes(1);
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });

  it('does not tear down services when stopAndRemove fails to remove the task container for a non-missing error', async () => {
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

    await expect(sandbox.stopAndRemove()).rejects.toThrow('remove failed');

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

  it('returns success from stopAndRemove when stop fails but remove succeeds', async () => {
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
    vi.spyOn(sandbox as any, 'remove').mockResolvedValue('removed');

    await expect(sandbox.stopAndRemove()).resolves.toBe('removed');
    expect(mockTeardownServiceContainers).toHaveBeenCalledTimes(1);
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });

  it('preserves persisted service names on graceful stop without reconstructing from current config', async () => {
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
      serviceConfigHash: 'service-hash',
    };

    expect(sandbox.getSandboxMetadata()).toEqual({
      dockerHost: 'tcp://remote:2375',
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: 'service-hash',
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

  it('tears down persisted service context when services are no longer configured', async () => {
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

    await expect(sandbox.ensureServicesForTest([])).resolves.toEqual({
      started: false,
      serviceContext: undefined,
    });

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
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });

  it('forwards DOCKER_HOST when tearing down removed service configurations', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      {
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

    await sandbox.ensureServicesForTest(undefined);

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

  it('ignores stale cleanup failures when services are no longer configured', async () => {
    mockTeardownServiceContainers.mockRejectedValueOnce(
      new Error('cleanup failed')
    );

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

    await expect(sandbox.ensureServicesForTest([])).resolves.toEqual({
      started: false,
      serviceContext: undefined,
    });
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });

  it('recreates services when the persisted context does not match the current service config', async () => {
    mockIsServiceContainerContextAvailable.mockResolvedValue(true);

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
            serviceConfigHash: 'outdated-hash',
          },
        },
      }
    );

    const services = [
      { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
    ];

    await expect(sandbox.ensureServicesForTest(services)).resolves.toEqual({
      started: true,
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: hashServices(services),
      },
    });

    expect(mockIsServiceContainerContextAvailable).not.toHaveBeenCalled();
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: 'outdated-hash',
      },
      undefined
    );
    expect(mockCreateServiceNetwork).toHaveBeenCalledWith(
      'docker',
      12,
      3,
      undefined
    );
    expect(mockStartServiceContainers).toHaveBeenCalledWith(
      'docker',
      services,
      'rover-services-12-3',
      12,
      3,
      undefined,
      expect.any(Function)
    );
    expect(mockWaitForServicesReady).toHaveBeenCalledWith(
      'docker',
      services,
      ['rover-svc-12-3-postgres'],
      undefined
    );
  });

  it('uses newly started services even after services were previously torn down on the same sandbox instance', async () => {
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
            containerNames: ['rover-svc-12-3-old-postgres'],
            taskId: 12,
            iteration: 3,
          },
        },
      }
    );

    await sandbox.teardownServices();

    await expect(
      sandbox.ensureServicesForTest([
        { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
      ])
    ).resolves.toEqual({
      started: true,
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: hashServices([
          { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
        ]),
      },
    });

    expect(sandbox.getSandboxMetadata()).toEqual({
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: hashServices([
          { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
        ]),
      },
    });
  });

  it('cleans up orphaned deterministic service resources before recreating services', async () => {
    mockHasAnyServiceContainerResources.mockResolvedValueOnce(true);

    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      { projectPath: '/repo' }
    );

    await expect(
      sandbox.ensureServicesForTest([
        { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
      ])
    ).resolves.toEqual({
      started: true,
      serviceContext: {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: hashServices([
          { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
        ]),
      },
    });

    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      'docker',
      {
        networkName: 'rover-services-12-3',
        containerNames: ['rover-svc-12-3-postgres'],
        taskId: 12,
        iteration: 3,
        serviceConfigHash: hashServices([
          { name: 'postgres', image: 'postgres:16', readyTimeout: 30 },
        ]),
      },
      undefined
    );
    expect(mockCreateServiceNetwork).toHaveBeenCalledWith(
      'docker',
      12,
      3,
      undefined
    );
  });
});
