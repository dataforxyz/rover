import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLaunch,
  mockProjectConfigLoad,
  mockCreateServiceNetwork,
  mockStartServiceContainers,
  mockWaitForServicesReady,
  mockTeardownServiceContainers,
  mockTmpUserGroupFiles,
  mockEnsureDownloadCacheVolumes,
  mockGetDownloadCacheMounts,
  mockGetServiceNetworkArgs,
  mockValidateSandboxWorktreePath,
} = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockProjectConfigLoad: vi.fn(),
  mockCreateServiceNetwork: vi.fn(),
  mockStartServiceContainers: vi.fn(),
  mockWaitForServicesReady: vi.fn(),
  mockTeardownServiceContainers: vi.fn(),
  mockTmpUserGroupFiles: vi.fn(),
  mockEnsureDownloadCacheVolumes: vi.fn(),
  mockGetDownloadCacheMounts: vi.fn(),
  mockGetServiceNetworkArgs: vi.fn(),
  mockValidateSandboxWorktreePath: vi.fn(),
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
  createServiceNetwork: mockCreateServiceNetwork,
  getServiceNetworkArgs: mockGetServiceNetworkArgs,
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
        expect.any(Object)
      );
    } else {
      expect(mockTeardownServiceContainers).toHaveBeenCalledWith(backend, {
        networkName: 'rover-services-1-1',
        containerNames: [],
        taskId: 1,
        iteration: 1,
      });
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

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('attaches %s workspace shells to the persisted service network', async (_label, SandboxCtor, backend) => {
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
});
