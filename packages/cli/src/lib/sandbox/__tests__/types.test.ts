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
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith('docker', {
      networkName: 'rover-services-12-3',
      containerNames: ['rover-svc-12-3-postgres', 'rover-svc-12-3-redis'],
      taskId: 12,
      iteration: 3,
    });
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
});
