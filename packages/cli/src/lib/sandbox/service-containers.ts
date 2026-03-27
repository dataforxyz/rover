/**
 * Per-task service container (sidecar) lifecycle management.
 *
 * Creates an isolated Docker/Podman network for each task, starts configured
 * service containers on it, waits for health, and tears everything down when
 * the task finishes.  Backend-agnostic: accepts a ContainerBackend parameter
 * so the same functions work for both Docker and Podman.
 */
import { launch, VERBOSE } from 'rover-core';
import { parseCommandString } from 'execa';
import type { ServiceContainer } from 'rover-schemas';
import { ContainerBackend } from './container-common.js';

export interface ServiceContainerContext {
  networkName: string;
  containerNames: string[];
  taskId: number;
  iteration: number;
}

function serviceContainerName(
  taskId: number,
  iteration: number,
  serviceName: string
): string {
  return `rover-svc-${taskId}-${iteration}-${serviceName}`;
}

function serviceNetworkName(taskId: number, iteration: number): string {
  return `rover-services-${taskId}-${iteration}`;
}

export function buildServiceContainerContext(
  services: Pick<ServiceContainer, 'name'>[],
  taskId: number,
  iteration: number
): ServiceContainerContext {
  return {
    networkName: serviceNetworkName(taskId, iteration),
    containerNames: services.map(service =>
      serviceContainerName(taskId, iteration, service.name)
    ),
    taskId,
    iteration,
  };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export async function createServiceNetwork(
  backend: ContainerBackend,
  taskId: number,
  iteration: number,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const networkName = serviceNetworkName(taskId, iteration);
  const opts = env ? { env } : undefined;
  const inspectOpts = opts
    ? { ...opts, reject: false as const }
    : { reject: false as const };

  if (VERBOSE) {
    console.error(`[rover] creating service network ${networkName}`);
  }

  const inspectResult = await launch(
    backend,
    ['network', 'inspect', networkName],
    inspectOpts
  );
  if (inspectResult.exitCode === 0) {
    if (VERBOSE) {
      console.error(`[rover] reusing existing service network ${networkName}`);
    }
    return networkName;
  }

  try {
    await launch(backend, ['network', 'create', networkName], opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('already exists')) {
      if (VERBOSE) {
        console.error(
          `[rover] service network ${networkName} was created concurrently; reusing it`
        );
      }
      return networkName;
    }
    throw error;
  }
  return networkName;
}

export async function hasAnyServiceContainerResources(
  backend: ContainerBackend,
  context: ServiceContainerContext,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  const opts = env
    ? { env, reject: false as const }
    : { reject: false as const };

  const networkInspect = await launch(
    backend,
    ['network', 'inspect', context.networkName],
    opts
  );
  if (networkInspect.exitCode === 0) {
    return true;
  }

  for (const name of context.containerNames) {
    const containerInspect = await launch(
      backend,
      ['inspect', '--format', '{{.Id}}', name],
      opts
    );
    if (containerInspect.exitCode === 0) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Start services
// ---------------------------------------------------------------------------

export async function startServiceContainers(
  backend: ContainerBackend,
  services: ServiceContainer[],
  networkName: string,
  taskId: number,
  iteration: number,
  env?: NodeJS.ProcessEnv,
  onContainerStarted?: (containerNames: string[]) => void
): Promise<string[]> {
  const opts = env ? { env } : undefined;
  const containerNames: string[] = [];

  for (const service of services) {
    const name = serviceContainerName(taskId, iteration, service.name);
    containerNames.push(name);

    const args: string[] = [
      'create',
      '--name',
      name,
      '--network',
      networkName,
      '--network-alias',
      service.name,
    ];

    // Environment variables
    for (const envVar of service.env ?? []) {
      args.push('-e', envVar);
    }

    // Volume mounts
    for (const vol of service.volumes ?? []) {
      args.push('-v', vol);
    }

    // Healthcheck
    if (service.healthcheck) {
      const hc = service.healthcheck;
      args.push(
        '--health-cmd',
        hc.cmd,
        '--health-interval',
        `${hc.interval}s`,
        '--health-timeout',
        `${hc.timeout}s`,
        '--health-retries',
        `${hc.retries}`,
        '--health-start-period',
        `${hc.startPeriod}s`
      );
    }

    // Image
    args.push(service.image);

    // Command override
    if (service.command) {
      if (Array.isArray(service.command)) {
        args.push(...service.command);
      } else {
        args.push(...parseCommandString(service.command));
      }
    }

    if (VERBOSE) {
      console.error(`[rover] creating service container ${name}`);
    }

    await launch(backend, args, opts);
    onContainerStarted?.([...containerNames]);
    await launch(backend, ['start', name], opts);
  }

  return containerNames;
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForServicesReady(
  backend: ContainerBackend,
  services: ServiceContainer[],
  containerNames: string[],
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const opts = env ? { env } : undefined;

  for (let i = 0; i < services.length; i++) {
    const service = services[i];
    const containerName = containerNames[i];

    // Services without a healthcheck are assumed ready immediately
    if (!service.healthcheck) {
      continue;
    }

    const timeout = Number.isFinite(service.readyTimeout)
      ? service.readyTimeout
      : 30;
    const deadline = Date.now() + timeout * 1000;

    if (VERBOSE) {
      console.error(
        `[rover] waiting for service ${service.name} to become healthy (timeout: ${service.readyTimeout}s)`
      );
    }

    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const result = await launch(
          backend,
          ['inspect', '--format', '{{.State.Health.Status}}', containerName],
          opts
        );
        const status = result.stdout?.toString().trim();

        if (status === 'healthy') {
          if (VERBOSE) {
            console.error(`[rover] service ${service.name} is healthy`);
          }
          healthy = true;
          break;
        }

        if (status === 'unhealthy') {
          throw new Error(`Service "${service.name}" reported unhealthy`);
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.includes('reported unhealthy')
        ) {
          throw error;
        }
        // inspect may fail if container is still starting — retry
      }

      await sleep(2000);
    }

    if (!healthy) {
      throw new Error(
        `Service "${service.name}" did not become healthy within ${service.readyTimeout}s`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Network args for the task container
// ---------------------------------------------------------------------------

export function getServiceNetworkArgs(networkName: string): string[] {
  return ['--network', networkName];
}

export async function isServiceContainerContextAvailable(
  backend: ContainerBackend,
  context: ServiceContainerContext,
  env?: NodeJS.ProcessEnv
): Promise<boolean> {
  const opts = env
    ? { env, reject: false as const }
    : { reject: false as const };

  const networkInspect = await launch(
    backend,
    ['network', 'inspect', context.networkName],
    opts
  );
  if (networkInspect.exitCode !== 0) {
    return false;
  }

  for (const name of context.containerNames) {
    const containerInspect = await launch(
      backend,
      ['inspect', '--format', '{{json .State}}', name],
      opts
    );
    if (containerInspect.exitCode !== 0) {
      return false;
    }

    try {
      const state = JSON.parse(String(containerInspect.stdout ?? '')) as {
        Running?: boolean;
        Status?: string;
        Health?: { Status?: string };
      };

      if (state.Running !== true) {
        return false;
      }

      const healthStatus = state.Health?.Status;
      if (
        typeof healthStatus === 'string' &&
        !['healthy', 'none'].includes(healthStatus)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function teardownServiceContainers(
  backend: ContainerBackend,
  context: ServiceContainerContext,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const opts = env ? { env } : undefined;

  // Remove service containers (best-effort)
  for (const name of context.containerNames) {
    try {
      await launch(backend, ['rm', '-f', name], opts);
    } catch {
      if (VERBOSE) {
        console.error(`[rover] failed to remove service container ${name}`);
      }
    }
  }

  // Remove the network (best-effort)
  try {
    await launch(backend, ['network', 'rm', context.networkName], opts);
  } catch {
    if (VERBOSE) {
      console.error(
        `[rover] failed to remove service network ${context.networkName}`
      );
    }
  }
}
