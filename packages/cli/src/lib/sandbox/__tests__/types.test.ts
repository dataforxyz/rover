import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../types.js';

const { mockTeardownServiceContainers, mockProjectConfigLoad } = vi.hoisted(
  () => ({
    mockTeardownServiceContainers: vi.fn(),
    mockProjectConfigLoad: vi.fn(),
  })
);

vi.mock('../service-containers.js', () => ({
  buildServiceContainerContext: vi.fn(
    (services: Array<{ name: string }>, taskId: number, iteration: number) => ({
      networkName: `rover-services-${taskId}-${iteration}`,
      containerNames: services.map(
        service => `rover-svc-${taskId}-${iteration}-${service.name}`
      ),
      taskId,
      iteration,
    })
  ),
  teardownServiceContainers: mockTeardownServiceContainers,
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

  async openShellAtWorktree(): Promise<void> {}

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
    mockProjectConfigLoad.mockReturnValue({
      services: [{ name: 'postgres' }, { name: 'redis' }],
    });
  });

  it('tears down configured services during stop on a fresh sandbox instance', async () => {
    const sandbox = new TestSandbox(
      {
        id: 12,
        iterations: 3,
      } as any,
      undefined,
      { projectPath: '/repo' }
    );

    await sandbox.stopAndRemove();

    expect(mockProjectConfigLoad).toHaveBeenCalledWith('/repo');
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
        sandboxMetadata: { dockerHost: 'tcp://remote:2375' },
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
});
