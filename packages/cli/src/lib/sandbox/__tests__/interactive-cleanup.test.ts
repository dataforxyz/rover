import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLaunch,
  mockProjectConfigLoad,
  mockCreateServiceNetwork,
  mockHasAnyServiceContainerResources,
  mockStartServiceContainers,
  mockWaitForServicesReady,
  mockIsServiceContainerContextAvailable,
  mockTeardownServiceContainers,
  mockTmpUserGroupFiles,
  mockEnsureDownloadCacheVolumes,
  mockGetDownloadCacheMounts,
  mockGetServiceNetworkArgs,
  mockValidateSandboxWorktreePath,
  mockGetRepositoryMounts,
} = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockProjectConfigLoad: vi.fn(),
  mockCreateServiceNetwork: vi.fn(),
  mockHasAnyServiceContainerResources: vi.fn(),
  mockStartServiceContainers: vi.fn(),
  mockWaitForServicesReady: vi.fn(),
  mockIsServiceContainerContextAvailable: vi.fn(),
  mockTeardownServiceContainers: vi.fn(),
  mockTmpUserGroupFiles: vi.fn(),
  mockEnsureDownloadCacheVolumes: vi.fn(),
  mockGetDownloadCacheMounts: vi.fn(),
  mockGetServiceNetworkArgs: vi.fn(),
  mockValidateSandboxWorktreePath: vi.fn(),
  mockGetRepositoryMounts: vi.fn<
    () => Array<{ hostPath: string; containerPath: string }>
  >(() => []),
}));

vi.mock('rover-core', () => ({
  generateRandomId: vi.fn(() => 'random-id'),
  launch: mockLaunch,
  ProcessManager: class {},
  ProjectConfigManager: {
    load: mockProjectConfigLoad,
  },
  TaskDescriptionManager: class {},
  VERBOSE: false,
}));

vi.mock('../../agents/index.js', () => ({
  getAIAgentTool: vi.fn(() => ({
    getContainerMounts: () => [],
    getEnvironmentVariables: () => [],
  })),
}));

vi.mock('../../context.js', () => ({
  isJsonMode: vi.fn(() => false),
}));

vi.mock('../../network-config.js', () => ({
  mergeNetworkConfig: vi.fn(() => undefined),
}));

vi.mock('../../setup.js', () => ({
  SetupBuilder: class {
    generateEntrypoint() {
      return '/tmp/entrypoint.sh';
    }

    generateWorkspaceDescription() {
      return undefined;
    }

    getRepositoryMounts() {
      return mockGetRepositoryMounts();
    }
  },
}));

vi.mock('../container-image-cache.js', () => ({
  checkImageCache: vi.fn(() => ({
    hasCachedImage: false,
    cacheTag: 'rover-cache:test',
  })),
}));

vi.mock('../download-cache.js', () => ({
  ensureDownloadCacheVolumes: mockEnsureDownloadCacheVolumes,
  getDownloadCacheMounts: mockGetDownloadCacheMounts,
}));

vi.mock('../container-common.js', () => ({
  ContainerBackend: {
    Docker: 'docker',
    Podman: 'podman',
  },
  getCheckpointArgs: vi.fn(() => []),
  getWorktreeGitMounts: vi.fn(() => []),
  normalizeExtraArgs: vi.fn(() => []),
  resolveAgentImage: vi.fn(() => 'agent:latest'),
  resolveInitScriptPath: vi.fn(() => '/tmp/init-script.sh'),
  getInitScriptMounts: vi.fn(() => []),
  tmpUserGroupFiles: mockTmpUserGroupFiles,
  warnIfCustomImage: vi.fn(),
}));

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
  getServiceNetworkArgs: mockGetServiceNetworkArgs,
  hasAnyServiceContainerResources: mockHasAnyServiceContainerResources,
  isServiceContainerContextAvailable: mockIsServiceContainerContextAvailable,
  startServiceContainers: mockStartServiceContainers,
  teardownServiceContainers: mockTeardownServiceContainers,
  waitForServicesReady: mockWaitForServicesReady,
}));

vi.mock('../worktree-path.js', () => ({
  validateSandboxWorktreePath: mockValidateSandboxWorktreePath,
}));

import { DockerSandbox } from '../docker.js';
import { PodmanSandbox } from '../podman.js';

function createTaskFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'rover-interactive-cleanup-'));
  const worktreePath = join(baseDir, 'worktree');
  const iterationPath = join(baseDir, 'iteration');
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(iterationPath, { recursive: true });

  return {
    id: 1,
    iterations: 1,
    agent: 'claude',
    worktreePath,
    getLastIteration: () => ({
      iterationPath,
    }),
  } as any;
}

describe('interactive sandbox cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLaunch.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    mockProjectConfigLoad.mockReturnValue({
      services: [{ name: 'postgres' }],
      envs: [],
      allInitScripts: [],
      projectRoot: '/repo',
    });
    mockCreateServiceNetwork.mockResolvedValue('rover-services-1-1');
    mockHasAnyServiceContainerResources.mockResolvedValue(false);
    mockIsServiceContainerContextAvailable.mockResolvedValue(false);
    mockStartServiceContainers.mockResolvedValue(['rover-svc-1-1-postgres']);
    mockWaitForServicesReady.mockResolvedValue(undefined);
    mockTmpUserGroupFiles.mockResolvedValue({
      etcPasswd: '/tmp/passwd',
      etcGroup: '/tmp/group',
      cleanup: vi.fn(),
    });
    mockGetDownloadCacheMounts.mockReturnValue([]);
    mockGetServiceNetworkArgs.mockReturnValue([
      '--network',
      'rover-services-1-1',
    ]);
    mockGetRepositoryMounts.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('tears down %s sidecars after interactive exit', async (_label, SandboxCtor, backend) => {
    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
    });

    await sandbox.runInteractive('fix the bug');

    expect(mockLaunch).toHaveBeenCalledWith(
      backend,
      expect.arrayContaining(['run', '--rm']),
      expect.objectContaining({
        detached: false,
        reject: false,
        stdio: 'inherit',
      })
    );
    if (backend === 'docker') {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
        backend,
        {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
        expect.any(Object)
      );
    } else {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(backend, {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      });
    }
    expect((sandbox as any).serviceContext).toBeUndefined();
  });

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('mounts local workspace repositories for interactive %s sessions', async (_label, SandboxCtor, backend) => {
    mockGetRepositoryMounts.mockReturnValue([
      {
        hostPath: '/repo/repos/frontend.git',
        containerPath: '/workspace-repos/0',
      },
    ]);

    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
    });

    await sandbox.runInteractive('fix the bug');

    expect(mockLaunch).toHaveBeenCalledWith(
      backend,
      expect.arrayContaining([
        '-v',
        '/repo/repos/frontend.git:/workspace-repos/0:Z,ro',
      ]),
      expect.objectContaining({
        detached: false,
        reject: false,
        stdio: 'inherit',
      })
    );
  });

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('tears down %s sidecars if interactive startup fails after creating the network', async (_label, SandboxCtor, backend) => {
    mockStartServiceContainers.mockRejectedValueOnce(
      new Error('service startup failed')
    );
    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
    });

    await expect(sandbox.runInteractive()).rejects.toThrow(
      'service startup failed'
    );

    if (backend === 'docker') {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
        backend,
        {
          networkName: 'rover-services-1-1',
          containerNames: [],
          taskId: 1,
          iteration: 1,
        },
        undefined
      );
    } else {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
        backend,
        {
          networkName: 'rover-services-1-1',
          containerNames: [],
          taskId: 1,
          iteration: 1,
        },
        undefined
      );
    }
    expect((sandbox as any).serviceContext).toBeUndefined();
  });

  it.each([
    ['docker', DockerSandbox],
    ['podman', PodmanSandbox],
  ])('preserves the interactive failure when %s sidecar cleanup also fails', async (_label, SandboxCtor) => {
    mockLaunch.mockRejectedValueOnce(new Error('interactive run failed'));
    mockTeardownServiceContainers.mockRejectedValueOnce(
      new Error('cleanup failed')
    );
    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
    });

    await expect(sandbox.runInteractive()).rejects.toThrow(
      'interactive run failed'
    );
  });

  it.each([
    ['docker', DockerSandbox],
    ['podman', PodmanSandbox],
  ])('reuses persisted %s sidecars for interactive sessions', async (_label, SandboxCtor) => {
    mockIsServiceContainerContextAvailable.mockResolvedValueOnce(true);

    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
      sandboxMetadata: {
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });

    await sandbox.runInteractive('fix the bug');

    expect(mockCreateServiceNetwork).not.toHaveBeenCalled();
    expect(mockStartServiceContainers).not.toHaveBeenCalled();
    expect(mockWaitForServicesReady).not.toHaveBeenCalled();
    expect(mockGetServiceNetworkArgs).toHaveBeenCalledWith(
      'rover-services-1-1'
    );
    expect(mockTeardownServiceContainers).not.toHaveBeenCalled();
    expect(sandbox.getSandboxMetadata()).toEqual({
      serviceContext: {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
    });
  });

  it('forwards DOCKER_HOST to docker interactive runs and shells', async () => {
    mockIsServiceContainerContextAvailable.mockResolvedValue(true);

    const sandbox = new DockerSandbox(createTaskFixture(), undefined, {
      projectPath: '/repo',
      sandboxMetadata: {
        dockerHost: 'tcp://remote:2375',
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });

    await sandbox.runInteractive('fix the bug');
    await sandbox.openShellAtWorktree();

    expect(mockLaunch).toHaveBeenNthCalledWith(
      1,
      'docker',
      expect.arrayContaining(['run', '--name', 'rover-task-1-1-i']),
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_HOST: 'tcp://remote:2375' }),
      })
    );
    expect(mockLaunch).toHaveBeenNthCalledWith(
      2,
      'docker',
      expect.arrayContaining([
        'run',
        '--rm',
        '--name',
        'rover-shell-1-random-id',
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ DOCKER_HOST: 'tcp://remote:2375' }),
      })
    );
  });

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('attaches %s workspace shells to the persisted service network', async (_label, SandboxCtor, backend) => {
    mockIsServiceContainerContextAvailable.mockResolvedValueOnce(true);

    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
      sandboxMetadata: {
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });

    await sandbox.openShellAtWorktree();

    expect(mockGetServiceNetworkArgs).toHaveBeenCalledWith(
      'rover-services-1-1'
    );
    expect(mockLaunch).toHaveBeenCalledWith(
      backend,
      expect.arrayContaining([
        'run',
        '--rm',
        '--network',
        'rover-services-1-1',
      ]),
      expect.objectContaining({
        detached: false,
        reject: false,
        stdio: 'inherit',
      })
    );
  });

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('recreates stale %s sidecars for workspace shells', async (_label, SandboxCtor, backend) => {
    mockIsServiceContainerContextAvailable.mockResolvedValueOnce(false);

    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      projectPath: '/repo',
      sandboxMetadata: {
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });

    await sandbox.openShellAtWorktree();

    if (backend === 'docker') {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
        backend,
        {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
        undefined
      );
    } else {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(backend, {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      });
    }
    expect(mockCreateServiceNetwork).toHaveBeenCalled();
    expect(mockStartServiceContainers).toHaveBeenCalled();
    expect(mockWaitForServicesReady).toHaveBeenCalled();
  });
});
