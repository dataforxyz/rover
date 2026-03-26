import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedLaunch = vi.hoisted(() => vi.fn());

vi.mock('rover-core', () => ({
  launch: mockedLaunch,
  VERBOSE: false,
}));

import {
  createServiceNetwork,
  getServiceNetworkArgs,
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
  });
});
