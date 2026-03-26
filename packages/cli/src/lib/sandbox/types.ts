import {
  launch,
  ProcessManager,
  ProjectConfigManager,
  TaskDescriptionManager,
} from 'rover-core';
import {
  loadEnvsFile,
  parseCustomEnvironmentVariables,
} from '../../utils/env-variables.js';
import { AIAgentTool } from '../agents/index.js';
import { ContainerBackend } from './container-common.js';
import {
  createServiceNetwork,
  isServiceContainerContextAvailable,
  startServiceContainers,
  type ServiceContainerContext,
  teardownServiceContainers,
  waitForServicesReady,
} from './service-containers.js';
import type { ServiceContainer } from 'rover-schemas';

const SERVICE_CONTEXT_METADATA_KEY = 'serviceContext';

export interface SandboxOptions {
  /** Extra arguments to pass to Docker/Podman from CLI */
  extraArgs?: string;
  /** Project root path for loading configuration */
  projectPath?: string;
  /** Sandbox-specific metadata (from task metadata) */
  sandboxMetadata?: Record<string, unknown>;
  /** Path to mount as /logs inside the container for this iteration */
  iterationLogsPath?: string;
  /** Path to checkpoint.json for resuming a paused workflow */
  checkpointPath?: string;
  /** Resume from an existing checkpoint without resetting workspace state */
  resumeFromCheckpoint?: boolean;
}

export abstract class SandboxPackage {
  abstract name: string;

  abstract installScript(): string;
  abstract initScript(): string;
}

export abstract class Sandbox {
  abstract backend: string;

  processManager?: ProcessManager;
  task: TaskDescriptionManager;
  options?: SandboxOptions;
  protected serviceContext?: ServiceContainerContext;
  private servicesTornDown = false;

  constructor(
    task: TaskDescriptionManager,
    processManager?: ProcessManager,
    options?: SandboxOptions
  ) {
    this.task = task;
    this.processManager = processManager;
    this.options = options;
  }

  abstract isBackendAvailable(): Promise<boolean>;
  abstract openShellAtWorktree(): Promise<{ exitCode?: number }>;
  abstract inspect(): Promise<{ status: string; exitCode?: number } | null>;

  protected abstract create(): Promise<string>;
  protected abstract start(): Promise<string>;
  protected abstract remove(): Promise<string>;
  protected abstract stop(): Promise<string>;
  protected abstract logs(): Promise<string>;
  protected abstract followLogs(): AsyncIterable<string>;

  abstract runInteractive(
    initialPrompt?: string
  ): Promise<ReturnType<typeof launch>>;

  protected get sandboxName(): string {
    return `rover-task-${this.task.id}-${this.task.iterations}`;
  }

  private getPersistedServiceContext(): ServiceContainerContext | undefined {
    if (this.servicesTornDown) {
      return undefined;
    }

    const persisted =
      this.options?.sandboxMetadata?.[SERVICE_CONTEXT_METADATA_KEY];
    const record =
      persisted && typeof persisted === 'object'
        ? (persisted as Record<string, unknown>)
        : undefined;

    if (
      record &&
      typeof record.networkName === 'string' &&
      Array.isArray(record.containerNames) &&
      record.containerNames.every(
        (name: unknown) => typeof name === 'string'
      ) &&
      typeof record.taskId === 'number' &&
      typeof record.iteration === 'number'
    ) {
      return {
        networkName: record.networkName,
        containerNames: [...record.containerNames],
        taskId: record.taskId,
        iteration: record.iteration,
      };
    }

    return undefined;
  }

  protected resolveServiceContext(): ServiceContainerContext | undefined {
    if (this.servicesTornDown) {
      return undefined;
    }

    if (this.serviceContext) {
      return this.serviceContext;
    }

    return this.getPersistedServiceContext();
  }

  protected getContainerBackend(): ContainerBackend {
    return this.backend === 'docker'
      ? ContainerBackend.Docker
      : ContainerBackend.Podman;
  }

  protected getServiceEnvironment(): NodeJS.ProcessEnv | undefined {
    const dockerHost = this.options?.sandboxMetadata?.dockerHost;
    if (typeof dockerHost === 'string') {
      return { ...process.env, DOCKER_HOST: dockerHost };
    }

    return undefined;
  }

  protected async teardownServicesIfConfigured(): Promise<void> {
    const serviceContext = this.resolveServiceContext();
    if (!serviceContext) {
      return;
    }

    await teardownServiceContainers(
      this.getContainerBackend(),
      serviceContext,
      this.getServiceEnvironment()
    );
    this.serviceContext = undefined;
    this.servicesTornDown = true;
  }

  protected async ensureServiceContext(
    services: ServiceContainer[] | undefined
  ): Promise<{ started: boolean; serviceContext?: ServiceContainerContext }> {
    if (!services || services.length === 0) {
      return {
        started: false,
        serviceContext: this.resolveServiceContext(),
      };
    }

    const env = this.getServiceEnvironment();
    const existingServiceContext = this.resolveServiceContext();
    if (existingServiceContext) {
      const isAvailable = await isServiceContainerContextAvailable(
        this.getContainerBackend(),
        existingServiceContext,
        env
      );
      if (isAvailable) {
        return {
          started: false,
          serviceContext: existingServiceContext,
        };
      }

      await teardownServiceContainers(
        this.getContainerBackend(),
        existingServiceContext,
        env
      );
      this.serviceContext = undefined;
    }

    const networkName = await createServiceNetwork(
      this.getContainerBackend(),
      this.task.id,
      this.task.iterations,
      env
    );
    this.serviceContext = {
      networkName,
      containerNames: [],
      taskId: this.task.id,
      iteration: this.task.iterations,
    };

    try {
      const containerNames = await startServiceContainers(
        this.getContainerBackend(),
        services,
        networkName,
        this.task.id,
        this.task.iterations,
        env,
        startedContainerNames => {
          this.serviceContext = {
            networkName,
            containerNames: startedContainerNames,
            taskId: this.task.id,
            iteration: this.task.iterations,
          };
        }
      );
      this.serviceContext = {
        networkName,
        containerNames,
        taskId: this.task.id,
        iteration: this.task.iterations,
      };
      await waitForServicesReady(
        this.getContainerBackend(),
        services,
        containerNames,
        env
      );
      return {
        started: true,
        serviceContext: this.serviceContext,
      };
    } catch (error) {
      if (this.serviceContext) {
        try {
          await teardownServiceContainers(
            this.getContainerBackend(),
            this.serviceContext,
            env
          );
        } catch {
          // Preserve the original service startup error.
        }
      }
      this.serviceContext = undefined;
      throw error;
    }
  }

  async teardownServices(): Promise<void> {
    await this.teardownServicesIfConfigured();
  }

  getSandboxMetadata(): Record<string, unknown> | undefined {
    const metadata = this.options?.sandboxMetadata
      ? { ...this.options.sandboxMetadata }
      : {};
    delete metadata[SERVICE_CONTEXT_METADATA_KEY];

    if (
      typeof metadata.dockerHost !== 'string' &&
      typeof process.env.DOCKER_HOST === 'string'
    ) {
      metadata.dockerHost = process.env.DOCKER_HOST;
    }

    const serviceContext = this.resolveServiceContext();
    if (serviceContext) {
      metadata[SERVICE_CONTEXT_METADATA_KEY] = {
        networkName: serviceContext.networkName,
        containerNames: [...serviceContext.containerNames],
        taskId: serviceContext.taskId,
        iteration: serviceContext.iteration,
      };
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  async createAndStart(): Promise<string> {
    let sandboxId = '';
    this.processManager?.addItem(
      `Prepare sandbox (${this.backend}) | Name: ${this.sandboxName}`
    );
    try {
      sandboxId = await this.create();
      this.processManager?.completeLastItem();
      this.processManager?.addItem(
        `Start sandbox (${this.backend}) | Name: ${this.sandboxName}`
      );
      await this.start();
      this.processManager?.completeLastItem();
    } catch (err) {
      this.processManager?.failLastItem();
      this.processManager?.finish();
      throw err;
    }
    this.processManager?.finish();
    return sandboxId;
  }

  /**
   * Stop the container gracefully without removing it.
   * Sends SIGTERM, allowing the agent to save a checkpoint before exiting.
   * The container is NOT removed — use this for pausing tasks.
   */
  async stopGracefully(): Promise<string> {
    let sandboxId = '';
    let stopped = false;
    this.processManager?.addItem(
      `Stopping sandbox (${this.backend}) | Name: ${this.sandboxName}`
    );
    try {
      sandboxId = await this.stop();
      stopped = true;
      this.processManager?.completeLastItem();
    } catch (_err: any) {
      this.processManager?.failLastItem();
    } finally {
      this.processManager?.finish();
    }

    // Only tear down sidecars after the task container has definitely stopped.
    if (stopped) {
      await this.teardownServicesIfConfigured();
    }

    return sandboxId;
  }

  async stopAndRemove(): Promise<string> {
    let sandboxId = '';
    let removed = false;
    this.processManager?.addItem(
      `Stopping sandbox (${this.backend}) | Name: ${this.sandboxName}`
    );
    try {
      sandboxId = await this.stop();
      this.processManager?.completeLastItem();
    } catch (_err: any) {
      this.processManager?.failLastItem();
    } finally {
      this.processManager?.finish();
    }

    this.processManager?.addItem(
      `Removing sandbox (${this.backend}) | Name: ${this.sandboxName}`
    );

    try {
      sandboxId = await this.remove();
      removed = true;
      this.processManager?.completeLastItem();
    } catch (_err: any) {
      this.processManager?.failLastItem();
    } finally {
      this.processManager?.finish();
    }

    // Tear down service containers and network only after the task container
    // is definitely gone.
    if (removed) {
      await this.teardownServicesIfConfigured();
    }

    return sandboxId;
  }

  /**
   * Load the sandbox environment variables from the project configuration
   * and the AI agent default environment vars.
   */
  getSandboxEnvironmentVariables(
    agent: AIAgentTool,
    projectConfig: ProjectConfigManager
  ): string[] {
    const envVariables: string[] = agent.getEnvironmentVariables();

    // Load project config and merge custom environment variables
    let customEnvVariables: string[] = [];

    try {
      // Parse custom envs array
      if (projectConfig.envs && projectConfig.envs.length > 0) {
        customEnvVariables = parseCustomEnvironmentVariables(
          projectConfig.envs
        );
      }

      // Load envs from file
      if (projectConfig.envsFile) {
        const fileEnvVariables = loadEnvsFile(projectConfig);
        customEnvVariables = [...customEnvVariables, ...fileEnvVariables];
      }
    } catch (error) {
      // Silently skip if there's an error loading project config
    }

    // Merge agent environment variables with custom environment variables
    // IMPORTANT: Custom environment variables are appended after agent defaults.
    // In Podman, when the same environment variable appears multiple times, the last
    // occurrence takes precedence. This means custom environment variables will
    // override agent defaults if there are conflicts, which is the desired behavior.
    return [...envVariables, ...customEnvVariables];
  }
}
