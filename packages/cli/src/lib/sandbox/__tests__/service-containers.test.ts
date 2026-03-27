import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedLaunch = vi.hoisted(() => vi.fn());

vi.mock('rover-core', () => ({
  launch: mockedLaunch,
  VERBOSE: false,
}));

import {
  buildServiceContainerContext,
  createServiceNetwork,
  getServiceNetworkArgs,
  hasAnyServiceContainerResources,
  isServiceContainerContextAvailable,
  startServiceContainers,
  teardownServiceContainers,
  waitForServicesReady,
} from '../service-containers.js';
import { ContainerBackend } from '../container-common.js';
import type { ServiceContainer } from 'rover-schemas';

describe('service-containers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLaunch.mockResolvedValue({ stdout: '' });
  });

  describe('createServiceNetwork', () => {
    it('creates a docker network with the expected name', async () => {
      mockedLaunch.mockResolvedValueOnce({ stdout: '', exitCode: 1 });
      mockedLaunch.mockResolvedValueOnce({ stdout: '' });

      const name = await createServiceNetwork(ContainerBackend.Docker, 5, 2);

      expect(name).toBe('rover-services-5-2');
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'inspect', 'rover-services-5-2'],
        { reject: false }
      );
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'create', 'rover-services-5-2'],
        undefined
      );
    });

    it('passes env for DOCKER_HOST forwarding', async () => {
      const env = { DOCKER_HOST: 'tcp://remote:2375' } as NodeJS.ProcessEnv;
      mockedLaunch.mockResolvedValueOnce({ stdout: '', exitCode: 1 });
      mockedLaunch.mockResolvedValueOnce({ stdout: '' });
      await createServiceNetwork(ContainerBackend.Docker, 1, 1, env);

      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'inspect', 'rover-services-1-1'],
        { env, reject: false }
      );
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'create', 'rover-services-1-1'],
        { env }
      );
    });

    it('reuses an existing network instead of recreating it', async () => {
      mockedLaunch.mockResolvedValueOnce({ stdout: '[]', exitCode: 0 });

      const name = await createServiceNetwork(ContainerBackend.Docker, 7, 3);

      expect(name).toBe('rover-services-7-3');
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'inspect', 'rover-services-7-3'],
        { reject: false }
      );
    });

    it('reuses a network when create races with another creator', async () => {
      mockedLaunch.mockResolvedValueOnce({ stdout: '', exitCode: 1 });
      mockedLaunch.mockRejectedValueOnce(new Error('network already exists'));

      const name = await createServiceNetwork(ContainerBackend.Docker, 8, 4);

      expect(name).toBe('rover-services-8-4');
      expect(mockedLaunch).toHaveBeenNthCalledWith(
        2,
        ContainerBackend.Docker,
        ['network', 'create', 'rover-services-8-4'],
        undefined
      );
    });

    it('re-throws non-race-condition errors from network create', async () => {
      mockedLaunch.mockResolvedValueOnce({ stdout: '', exitCode: 1 });
      mockedLaunch.mockRejectedValueOnce(new Error('permission denied'));

      await expect(
        createServiceNetwork(ContainerBackend.Docker, 1, 1)
      ).rejects.toThrow('permission denied');
    });
  });

  describe('startServiceContainers', () => {
    it('creates and starts containers with correct args', async () => {
      const services: ServiceContainer[] = [
        {
          name: 'postgres',
          image: 'postgres:16',
          env: ['POSTGRES_PASSWORD=test'],
          ports: [5432],
          readyTimeout: 60,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 5,
            timeout: 5,
            retries: 3,
            startPeriod: 10,
          },
        },
      ];

      const names = await startServiceContainers(
        ContainerBackend.Docker,
        services,
        'rover-services-1-1',
        1,
        1
      );

      expect(names).toEqual(['rover-svc-1-1-postgres']);

      expect(mockedLaunch).toHaveBeenNthCalledWith(
        1,
        ContainerBackend.Docker,
        [
          'create',
          '--name',
          'rover-svc-1-1-postgres',
          '--network',
          'rover-services-1-1',
          '--network-alias',
          'postgres',
          '-e',
          'POSTGRES_PASSWORD=test',
          '--health-cmd',
          'pg_isready',
          '--health-interval',
          '5s',
          '--health-timeout',
          '5s',
          '--health-retries',
          '3',
          '--health-start-period',
          '10s',
          'postgres:16',
        ],
        undefined
      );

      expect(mockedLaunch).toHaveBeenNthCalledWith(
        2,
        ContainerBackend.Docker,
        ['start', 'rover-svc-1-1-postgres'],
        undefined
      );
    });

    it('handles services with volumes and command override', async () => {
      const services: ServiceContainer[] = [
        {
          name: 'redis',
          image: 'redis:7',
          volumes: ['redis-data:/data'],
          command: ['redis-server', '--maxmemory', '256mb'],
          readyTimeout: 60,
        },
      ];

      await startServiceContainers(
        ContainerBackend.Docker,
        services,
        'net',
        1,
        1
      );

      expect(mockedLaunch).toHaveBeenNthCalledWith(
        1,
        ContainerBackend.Docker,
        [
          'create',
          '--name',
          'rover-svc-1-1-redis',
          '--network',
          'net',
          '--network-alias',
          'redis',
          '-v',
          'redis-data:/data',
          'redis:7',
          'redis-server',
          '--maxmemory',
          '256mb',
        ],
        undefined
      );
    });

    it('splits string command overrides into argv entries', async () => {
      const services: ServiceContainer[] = [
        {
          name: 'redis',
          image: 'redis:7',
          command: 'redis-server --appendonly yes',
          readyTimeout: 60,
        },
      ];

      await startServiceContainers(
        ContainerBackend.Docker,
        services,
        'net',
        1,
        1
      );

      expect(mockedLaunch).toHaveBeenNthCalledWith(
        1,
        ContainerBackend.Docker,
        [
          'create',
          '--name',
          'rover-svc-1-1-redis',
          '--network',
          'net',
          '--network-alias',
          'redis',
          'redis:7',
          'redis-server',
          '--appendonly',
          'yes',
        ],
        undefined
      );
    });

    it('forwards env to create and start calls', async () => {
      const env = { DOCKER_HOST: 'tcp://remote:2375' } as NodeJS.ProcessEnv;
      const services: ServiceContainer[] = [
        { name: 'redis', image: 'redis:7', readyTimeout: 60 },
      ];

      await startServiceContainers(
        ContainerBackend.Docker,
        services,
        'net',
        1,
        1,
        env
      );

      expect(mockedLaunch).toHaveBeenNthCalledWith(
        1,
        ContainerBackend.Docker,
        expect.arrayContaining(['create', '--name', 'rover-svc-1-1-redis']),
        { env }
      );
      expect(mockedLaunch).toHaveBeenNthCalledWith(
        2,
        ContainerBackend.Docker,
        ['start', 'rover-svc-1-1-redis'],
        { env }
      );
    });

    it('creates containers with port mappings', async () => {
      const services: ServiceContainer[] = [
        {
          name: 'postgres',
          image: 'postgres:16',
          ports: [5432],
          readyTimeout: 60,
        },
      ];

      await startServiceContainers(
        ContainerBackend.Docker,
        services,
        'net',
        2,
        1
      );

      // ports are not mapped to host — they're accessible via the service
      // network by alias, so no -p flags should appear
      const createArgs = mockedLaunch.mock.calls[0][1];
      expect(createArgs).not.toContain('-p');
    });

    it('reports partially started containers before failing mid-loop', async () => {
      const onContainerStarted = vi.fn();
      const services: ServiceContainer[] = [
        { name: 'postgres', image: 'postgres:16', readyTimeout: 60 },
        { name: 'redis', image: 'redis:7', readyTimeout: 60 },
      ];

      mockedLaunch
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: '' })
        .mockRejectedValueOnce(new Error('name already in use'));

      await expect(
        startServiceContainers(
          ContainerBackend.Docker,
          services,
          'net',
          1,
          1,
          undefined,
          onContainerStarted
        )
      ).rejects.toThrow('name already in use');

      expect(onContainerStarted).toHaveBeenCalledTimes(1);
      expect(onContainerStarted).toHaveBeenCalledWith([
        'rover-svc-1-1-postgres',
      ]);
    });

    it('tracks newly created containers before failing to start a later service', async () => {
      const onContainerStarted = vi.fn();
      const services: ServiceContainer[] = [
        { name: 'postgres', image: 'postgres:16', readyTimeout: 60 },
        { name: 'redis', image: 'redis:7', readyTimeout: 60 },
      ];

      mockedLaunch
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: '' })
        .mockRejectedValueOnce(new Error('failed to start redis'));

      await expect(
        startServiceContainers(
          ContainerBackend.Docker,
          services,
          'net',
          1,
          1,
          undefined,
          onContainerStarted
        )
      ).rejects.toThrow('failed to start redis');

      expect(onContainerStarted).toHaveBeenCalledTimes(2);
      expect(onContainerStarted).toHaveBeenNthCalledWith(1, [
        'rover-svc-1-1-postgres',
      ]);
      expect(onContainerStarted).toHaveBeenNthCalledWith(2, [
        'rover-svc-1-1-postgres',
        'rover-svc-1-1-redis',
      ]);
    });
  });

  describe('waitForServicesReady', () => {
    it('skips services without healthcheck', async () => {
      const services: ServiceContainer[] = [
        { name: 'redis', image: 'redis:7', readyTimeout: 30 },
      ];

      await waitForServicesReady(ContainerBackend.Docker, services, [
        'rover-svc-1-1-redis',
      ]);

      expect(mockedLaunch).not.toHaveBeenCalled();
    });

    it('polls until healthy', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ stdout: 'starting' })
        .mockResolvedValueOnce({ stdout: 'healthy' });

      const services: ServiceContainer[] = [
        {
          name: 'pg',
          image: 'postgres:16',
          readyTimeout: 10,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 5,
            timeout: 5,
            retries: 3,
            startPeriod: 0,
          },
        },
      ];

      await waitForServicesReady(ContainerBackend.Docker, services, [
        'rover-svc-1-1-pg',
      ]);

      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['inspect', '--format', '{{.State.Health.Status}}', 'rover-svc-1-1-pg'],
        undefined
      );
    });

    it('throws on unhealthy status', async () => {
      mockedLaunch.mockResolvedValueOnce({ stdout: 'unhealthy' });

      const services: ServiceContainer[] = [
        {
          name: 'pg',
          image: 'postgres:16',
          readyTimeout: 10,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 5,
            timeout: 5,
            retries: 3,
            startPeriod: 0,
          },
        },
      ];

      await expect(
        waitForServicesReady(ContainerBackend.Docker, services, [
          'rover-svc-1-1-pg',
        ])
      ).rejects.toThrow('reported unhealthy');
    });

    it('throws timeout error when service does not become healthy in time', async () => {
      // Always return 'starting' so it never becomes healthy
      mockedLaunch.mockResolvedValue({ stdout: 'starting' });

      const services: ServiceContainer[] = [
        {
          name: 'slow',
          image: 'postgres:16',
          // Use a tiny timeout so the test completes quickly
          readyTimeout: 0,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 1,
            timeout: 1,
            retries: 1,
            startPeriod: 0,
          },
        },
      ];

      await expect(
        waitForServicesReady(ContainerBackend.Docker, services, [
          'rover-svc-1-1-slow',
        ])
      ).rejects.toThrow('did not become healthy within 0s');
    });

    it('retries on transient inspect failures then succeeds', async () => {
      mockedLaunch
        .mockRejectedValueOnce(new Error('container is restarting'))
        .mockResolvedValueOnce({ stdout: 'healthy' });

      const services: ServiceContainer[] = [
        {
          name: 'pg',
          image: 'postgres:16',
          readyTimeout: 30,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 5,
            timeout: 5,
            retries: 3,
            startPeriod: 0,
          },
        },
      ];

      await waitForServicesReady(ContainerBackend.Docker, services, [
        'rover-svc-1-1-pg',
      ]);

      expect(mockedLaunch).toHaveBeenCalledTimes(2);
    });

    it('waits for multiple services independently', async () => {
      // First service (no healthcheck) — no calls
      // Second service (with healthcheck) — polls once, gets healthy
      mockedLaunch.mockResolvedValueOnce({ stdout: 'healthy' });

      const services: ServiceContainer[] = [
        { name: 'redis', image: 'redis:7', readyTimeout: 10 },
        {
          name: 'pg',
          image: 'postgres:16',
          readyTimeout: 10,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 5,
            timeout: 5,
            retries: 3,
            startPeriod: 0,
          },
        },
      ];

      await waitForServicesReady(ContainerBackend.Docker, services, [
        'rover-svc-1-1-redis',
        'rover-svc-1-1-pg',
      ]);

      // Only the pg service should have triggered an inspect
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['inspect', '--format', '{{.State.Health.Status}}', 'rover-svc-1-1-pg'],
        undefined
      );
    });

    it('forwards env to health inspect calls', async () => {
      const env = { DOCKER_HOST: 'tcp://remote:2375' } as NodeJS.ProcessEnv;
      mockedLaunch.mockResolvedValueOnce({ stdout: 'healthy' });

      const services: ServiceContainer[] = [
        {
          name: 'pg',
          image: 'postgres:16',
          readyTimeout: 10,
          healthcheck: {
            cmd: 'pg_isready',
            interval: 5,
            timeout: 5,
            retries: 3,
            startPeriod: 0,
          },
        },
      ];

      await waitForServicesReady(
        ContainerBackend.Docker,
        services,
        ['rover-svc-1-1-pg'],
        env
      );

      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['inspect', '--format', '{{.State.Health.Status}}', 'rover-svc-1-1-pg'],
        { env }
      );
    });
  });

  describe('buildServiceContainerContext', () => {
    it('builds context with correct network name and container names', () => {
      const ctx = buildServiceContainerContext(
        [{ name: 'postgres' }, { name: 'redis' }],
        5,
        3
      );

      expect(ctx).toEqual({
        networkName: 'rover-services-5-3',
        containerNames: ['rover-svc-5-3-postgres', 'rover-svc-5-3-redis'],
        taskId: 5,
        iteration: 3,
      });
    });

    it('returns empty containerNames for empty services array', () => {
      const ctx = buildServiceContainerContext([], 1, 1);
      expect(ctx.containerNames).toEqual([]);
      expect(ctx.networkName).toBe('rover-services-1-1');
    });
  });

  describe('getServiceNetworkArgs', () => {
    it('returns correct network args', () => {
      expect(getServiceNetworkArgs('rover-services-1-1')).toEqual([
        '--network',
        'rover-services-1-1',
      ]);
    });
  });

  describe('isServiceContainerContextAvailable', () => {
    it('returns true when the network exists and all containers are running', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Running: true }),
        });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(true);
    });

    it('returns false when a container exists but is stopped', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Running: false }),
        });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);
    });

    it('returns false when a health-checked container is unhealthy', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            Running: true,
            Health: { Status: 'unhealthy' },
          }),
        });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);
    });

    it('returns false when a running health-checked container is still starting', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            Running: true,
            Health: { Status: 'starting' },
          }),
        });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);
    });

    it('returns false when the network does not exist', async () => {
      mockedLaunch.mockResolvedValueOnce({ exitCode: 1, stdout: '' });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);

      // Should not inspect containers if network is missing
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
    });

    it('returns false when container inspect returns malformed JSON', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'not json {{' });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);
    });

    it('returns false if any container in a multi-container context is stopped', async () => {
      mockedLaunch
        // network inspect
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        // first container — running
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Running: true }),
        })
        // second container — stopped
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Running: false }),
        });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres', 'rover-svc-1-1-redis'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);
    });

    it('returns true when all containers in a multi-container context are running', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Running: true }),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            Running: true,
            Health: { Status: 'healthy' },
          }),
        });

      await expect(
        isServiceContainerContextAvailable(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-redis', 'rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(true);
    });

    it('forwards env to inspect calls', async () => {
      const env = { DOCKER_HOST: 'tcp://remote:2375' } as NodeJS.ProcessEnv;
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Running: true }),
        });

      await isServiceContainerContextAvailable(
        ContainerBackend.Docker,
        {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-pg'],
          taskId: 1,
          iteration: 1,
        },
        env
      );

      expect(mockedLaunch).toHaveBeenNthCalledWith(
        1,
        ContainerBackend.Docker,
        ['network', 'inspect', 'rover-services-1-1'],
        { env, reject: false }
      );
      expect(mockedLaunch).toHaveBeenNthCalledWith(
        2,
        ContainerBackend.Docker,
        ['inspect', '--format', '{{json .State}}', 'rover-svc-1-1-pg'],
        { env, reject: false }
      );
    });
  });

  describe('hasAnyServiceContainerResources', () => {
    it('returns true when the service network already exists', async () => {
      mockedLaunch.mockResolvedValueOnce({ exitCode: 0, stdout: '[]' });

      await expect(
        hasAnyServiceContainerResources(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(true);

      expect(mockedLaunch).toHaveBeenCalledTimes(1);
    });

    it('returns true when a deterministic sidecar container exists without the network', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 1, stdout: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'container-id' });

      await expect(
        hasAnyServiceContainerResources(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(true);
    });

    it('returns false when neither the network nor expected containers exist', async () => {
      mockedLaunch
        .mockResolvedValueOnce({ exitCode: 1, stdout: '' })
        .mockResolvedValueOnce({ exitCode: 1, stdout: '' });

      await expect(
        hasAnyServiceContainerResources(ContainerBackend.Docker, {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-postgres'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBe(false);
    });
  });

  describe('teardownServiceContainers', () => {
    it('removes containers and network (best-effort)', async () => {
      await teardownServiceContainers(ContainerBackend.Docker, {
        networkName: 'rover-services-1-1',
        containerNames: ['rover-svc-1-1-pg', 'rover-svc-1-1-redis'],
        taskId: 1,
        iteration: 1,
      });

      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['rm', '-f', 'rover-svc-1-1-pg'],
        undefined
      );
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['rm', '-f', 'rover-svc-1-1-redis'],
        undefined
      );
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'rm', 'rover-services-1-1'],
        undefined
      );
    });

    it('does not throw if container removal fails', async () => {
      mockedLaunch.mockRejectedValue(new Error('container not found'));

      await expect(
        teardownServiceContainers(ContainerBackend.Docker, {
          networkName: 'net',
          containerNames: ['c1'],
          taskId: 1,
          iteration: 1,
        })
      ).resolves.toBeUndefined();
    });

    it('forwards env to rm and network rm calls', async () => {
      const env = { DOCKER_HOST: 'tcp://remote:2375' } as NodeJS.ProcessEnv;

      await teardownServiceContainers(
        ContainerBackend.Docker,
        {
          networkName: 'rover-services-1-1',
          containerNames: ['rover-svc-1-1-pg'],
          taskId: 1,
          iteration: 1,
        },
        env
      );

      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['rm', '-f', 'rover-svc-1-1-pg'],
        { env }
      );
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'rm', 'rover-services-1-1'],
        { env }
      );
    });

    it('continues removing remaining containers even if one fails', async () => {
      mockedLaunch
        .mockRejectedValueOnce(new Error('container not found'))
        .mockResolvedValueOnce({ stdout: '' })
        .mockResolvedValueOnce({ stdout: '' });

      await teardownServiceContainers(ContainerBackend.Docker, {
        networkName: 'net',
        containerNames: ['c1', 'c2'],
        taskId: 1,
        iteration: 1,
      });

      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['rm', '-f', 'c2'],
        undefined
      );
      expect(mockedLaunch).toHaveBeenCalledWith(
        ContainerBackend.Docker,
        ['network', 'rm', 'net'],
        undefined
      );
    });
  });
});
