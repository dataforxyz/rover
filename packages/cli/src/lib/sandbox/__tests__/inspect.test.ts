import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLaunch,
  mockTeardownServiceContainers,
  mockGetServiceNetworkArgs,
  mockCheckImageCache,
} = vi.hoisted(() => ({
  mockLaunch: vi.fn(),
  mockTeardownServiceContainers: vi.fn(),
  mockGetServiceNetworkArgs: vi.fn(() => ['--network', 'rover-services-1-1']),
  mockCheckImageCache: vi.fn(() => ({
    hasCachedImage: true,
    cacheTag: 'rover-cache:test',
  })),
}));

vi.mock('rover-core', () => ({
  generateRandomId: vi.fn(() => 'random-id'),
  launch: mockLaunch,
  ProcessManager: class {},
  ProjectConfigManager: {
    load: vi.fn(() => ({
      services: [],
      envs: [],
      allInitScripts: [],
      projectRoot: '/repo',
    })),
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

    generateInputs() {
      return '/tmp/inputs.json';
    }

    saveWorkflow() {
      return '/tmp/workflow.yml';
    }

    generateWorkspaceDescription() {
      return undefined;
    }
  },
}));

vi.mock('../container-image-cache.js', () => ({
  checkImageCache: mockCheckImageCache,
  waitForInitAndCommit: vi.fn(),
}));

vi.mock('../download-cache.js', () => ({
  ensureDownloadCacheVolumes: vi.fn(),
  getDownloadCacheMounts: vi.fn(() => []),
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
  tmpUserGroupFiles: vi.fn(async () => ({
    etcPasswd: '/tmp/passwd',
    etcGroup: '/tmp/group',
    cleanup: vi.fn(),
  })),
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
  createServiceNetwork: vi.fn(),
  getServiceNetworkArgs: mockGetServiceNetworkArgs,
  isServiceContainerContextAvailable: vi.fn(),
  startServiceContainers: vi.fn(),
  teardownServiceContainers: mockTeardownServiceContainers,
  waitForServicesReady: vi.fn(),
}));

vi.mock('../worktree-path.js', () => ({
  validateSandboxWorktreePath: vi.fn(),
}));

import { DockerSandbox } from '../docker.js';
import { PodmanSandbox } from '../podman.js';

function createTaskFixture() {
  return {
    id: 1,
    iterations: 1,
    agent: 'claude',
    worktreePath: '/tmp/worktree',
    getLastIteration: () => ({
      iterationPath: '/tmp/iteration',
      fileDescriptionPath: '/tmp/iteration/description.json',
    }),
  } as any;
}

describe('sandbox inspect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['docker', DockerSandbox, 'docker', { env: expect.any(Object) }],
    ['podman', PodmanSandbox, 'podman', { stdio: 'pipe' }],
  ])('does not tear down services for live %s statuses', async (_label, SandboxCtor, backend, inspectOptions) => {
    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      sandboxMetadata: {
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });

    for (const status of ['created', 'restarting', 'paused']) {
      mockLaunch.mockResolvedValueOnce({ stdout: `${status}|0` });

      await expect(sandbox.inspect()).resolves.toEqual({
        status,
        exitCode: 0,
      });
    }

    expect(mockLaunch).toHaveBeenCalledWith(
      backend,
      [
        'inspect',
        '--format',
        '{{.State.Status}}|{{.State.ExitCode}}',
        'rover-task-1-1',
      ],
      inspectOptions
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
    ['docker', DockerSandbox, 'docker', undefined],
    ['podman', PodmanSandbox, 'podman', undefined],
  ])('tears down services for exited %s containers', async (_label, SandboxCtor, backend, teardownEnv) => {
    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      sandboxMetadata: {
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });
    mockLaunch.mockResolvedValueOnce({ stdout: 'exited|1' });

    await expect(sandbox.inspect()).resolves.toEqual({
      status: 'exited',
      exitCode: 1,
    });

    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      backend,
      {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
      teardownEnv
    );
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });

  it.each([
    [
      'docker',
      DockerSandbox,
      'No such object: rover-task-1-1',
      'docker',
      { env: expect.any(Object) },
      undefined,
    ],
    [
      'podman',
      PodmanSandbox,
      'no such container "rover-task-1-1"',
      'podman',
      { stdio: 'pipe' },
      undefined,
    ],
  ])('tears down persisted services when %s inspect finds no task container', async (_label, SandboxCtor, stderr, backend, inspectOptions, teardownEnv) => {
    const sandbox = new SandboxCtor(createTaskFixture(), undefined, {
      sandboxMetadata: {
        serviceContext: {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        },
      },
    });
    const error = new Error(stderr) as Error & { stderr: string };
    error.stderr = stderr;
    mockLaunch.mockRejectedValueOnce(error);

    await expect(sandbox.inspect()).resolves.toBeNull();

    expect(mockLaunch).toHaveBeenCalledWith(
      backend,
      [
        'inspect',
        '--format',
        '{{.State.Status}}|{{.State.ExitCode}}',
        'rover-task-1-1',
      ],
      inspectOptions
    );
    expect(mockTeardownServiceContainers).toHaveBeenCalledWith(
      backend,
      {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-postgres'],
        taskId: 1,
        iteration: 1,
      },
      teardownEnv
    );
    expect(sandbox.getSandboxMetadata()).toBeUndefined();
  });

  it.each([
    ['docker', DockerSandbox, 'docker'],
    ['podman', PodmanSandbox, 'podman'],
  ])('attaches resumed %s task containers to the persisted service network', async (_label, SandboxCtor, backend) => {
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

    mockLaunch
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'container-1' })
      .mockResolvedValueOnce({ stdout: '' });

    await expect(sandbox.createAndStart()).resolves.toBe('container-1');

    expect(mockGetServiceNetworkArgs).toHaveBeenCalledWith(
      'rover-services-1-1'
    );
    expect(mockLaunch.mock.calls[1]?.[0]).toBe(backend);
    expect(mockLaunch.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        'create',
        '--name',
        'rover-task-1-1',
        '--network',
        'rover-services-1-1',
      ])
    );
  });
});
