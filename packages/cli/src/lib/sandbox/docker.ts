import { existsSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import colors from 'ansi-colors';
import {
  generateRandomId,
  launch,
  ProcessManager,
  ProjectConfigManager,
  TaskDescriptionManager,
  VERBOSE,
} from 'rover-core';
import { getAIAgentTool } from '../agents/index.js';
import { isJsonMode } from '../context.js';
import { mergeNetworkConfig } from '../network-config.js';
import { SetupBuilder } from '../setup.js';
import {
  ContainerBackend,
  getCheckpointArgs,
  getWorktreeGitMounts,
  normalizeExtraArgs,
  resolveAgentImage,
  getInitScriptMounts,
  tmpUserGroupFiles,
  warnIfCustomImage,
} from './container-common.js';
import {
  checkImageCache,
  waitForInitAndCommit,
} from './container-image-cache.js';
import {
  ensureDownloadCacheVolumes,
  getDownloadCacheMounts,
} from './download-cache.js';
import { isContainerMissingInspectError } from './inspect-errors.js';
import {
  createServiceNetwork,
  getServiceNetworkArgs,
  startServiceContainers,
  teardownServiceContainers,
  waitForServicesReady,
} from './service-containers.js';
import { Sandbox, SandboxOptions } from './types.js';
import { validateSandboxWorktreePath } from './worktree-path.js';

export class DockerSandbox extends Sandbox {
  backend = ContainerBackend.Docker;

  private cacheTag?: string;
  private shouldCommitCache = false;
  private initMode = false;
  private _tmpCleanups: Array<() => void> = [];

  private runTmpCleanups(): void {
    for (const cleanup of this._tmpCleanups) cleanup();
    this._tmpCleanups = [];
  }

  constructor(
    task: TaskDescriptionManager,
    processManager?: ProcessManager,
    options?: SandboxOptions
  ) {
    super(task, processManager, options);
  }

  async isBackendAvailable(): Promise<boolean> {
    try {
      // Check if docker command exists and verify it's actual Docker (not Podman)
      const result = await launch('docker', ['info', '--format', 'json']);
      const info = JSON.parse(result.stdout?.toString() || '{}');

      // Docker will have ServerVersion set, Podman (even aliased as docker) will not
      return info.ServerVersion != null;
    } catch (error) {
      return false;
    }
  }

  protected async create(): Promise<string> {
    const iteration = this.task.getLastIteration();

    if (!iteration) {
      throw new Error('No iteration data found for this task');
    }

    // Load project configuration
    const projectConfig = ProjectConfigManager.load(
      this.options?.projectPath ?? process.cwd()
    );
    const worktreePath = this.task.worktreePath;

    validateSandboxWorktreePath(worktreePath, projectConfig);

    // Resolve the agent image from env var, stored task image, config, or default
    const agentImage = resolveAgentImage(projectConfig, this.task.agentImage);

    // Check image cache
    const { hasCachedImage, cacheTag } = checkImageCache(
      ContainerBackend.Docker,
      projectConfig,
      agentImage,
      this.task.agent!
    );

    this.cacheTag = cacheTag;
    this.shouldCommitCache = !hasCachedImage;

    const effectiveImage = hasCachedImage ? cacheTag : agentImage;

    if (hasCachedImage && !isJsonMode()) {
      console.log(
        colors.green('Using cached setup image ') + colors.cyan(cacheTag)
      );
    }

    // Generate setup script using SetupBuilder
    const setupBuilder = new SetupBuilder(
      this.task,
      this.task.agent!,
      projectConfig,
      { resumeFromCheckpoint: this.options?.resumeFromCheckpoint }
    );
    const entrypointScriptPath = setupBuilder.generateEntrypoint(
      true,
      'entrypoint.sh',
      hasCachedImage
    );
    const inputsPath = setupBuilder.generateInputs();
    const workflowPath = setupBuilder.saveWorkflow(this.task.workflowName);

    // Get agent-specific Docker mounts and environment variables
    const agent = getAIAgentTool(this.task.agent!);
    const dockerMounts: string[] = agent.getContainerMounts();
    const envVariables: string[] = this.getSandboxEnvironmentVariables(
      agent,
      projectConfig
    );

    // Clean up any existing container with same name
    try {
      await launch('docker', ['rm', '-f', this.sandboxName]);
    } catch (error) {
      // Container doesn't exist, which is fine
    }

    const dockerArgs = ['create', '--name', this.sandboxName];

    // Attach to the service network if services are running
    if (this.serviceContext) {
      dockerArgs.push(
        ...getServiceNetworkArgs(this.serviceContext.networkName)
      );
    }

    const rawUserInfo = userInfo();
    const userInfo_ = {
      ...rawUserInfo,
      uid: rawUserInfo.uid === -1 ? 1000 : rawUserInfo.uid,
      gid: rawUserInfo.gid === -1 ? 1000 : rawUserInfo.gid,
    };

    // Warn if using a custom agent image
    warnIfCustomImage(projectConfig);

    const {
      etcPasswd,
      etcGroup,
      cleanup: cleanupTmpFiles,
    } = await tmpUserGroupFiles(
      ContainerBackend.Docker,
      effectiveImage,
      userInfo_
    );
    this._tmpCleanups.push(cleanupTmpFiles);

    // Add NET_ADMIN capability if network filtering is configured
    const effectiveNetworkConfig = mergeNetworkConfig(
      projectConfig.network,
      this.task.networkConfig
    );
    if (effectiveNetworkConfig && effectiveNetworkConfig.mode !== 'allowall') {
      dockerArgs.push('--cap-add=NET_ADMIN');
    }

    dockerArgs.push(
      '-v',
      `${etcPasswd}:/etc/passwd:Z,ro`,
      '-v',
      `${etcGroup}:/etc/group:Z,ro`,
      '--user',
      `${userInfo_.uid}:${userInfo_.gid}`,
      '-v',
      `${worktreePath}:/workspace:Z,rw`,
      ...getWorktreeGitMounts(worktreePath),
      '-v',
      `${iteration.iterationPath}:/output:Z,rw`
    );

    // Mount project-level logs directory
    if (this.options?.iterationLogsPath) {
      mkdirSync(this.options.iterationLogsPath, { recursive: true });
      dockerArgs.push('-v', `${this.options.iterationLogsPath}:/logs:Z,rw`);
    }

    dockerArgs.push(
      ...dockerMounts,
      '-v',
      `${entrypointScriptPath}:/entrypoint.sh:Z,ro`,
      '-v',
      `${workflowPath}:/workflow.yml:Z,ro`,
      '-v',
      `${inputsPath}:/inputs.json:Z,ro`,
      '-v',
      `${iteration.fileDescriptionPath}:/task/description.json:Z,ro`
    );

    // Mount context directory if available (read-only)
    const contextDir = join(iteration.iterationPath, 'context');
    const hasContext = existsSync(contextDir);
    if (hasContext) {
      dockerArgs.push('-v', `${contextDir}:/context:Z,ro`);
    }

    // Mount init scripts (root-only; project-scoped scripts run from cloned workspace)
    dockerArgs.push(
      ...getInitScriptMounts(projectConfig, { warnMissing: !isJsonMode() })
    );

    // Mount workspace description if projects are configured
    const workspaceDescPath = setupBuilder.generateWorkspaceDescription();
    if (workspaceDescPath) {
      dockerArgs.push(
        '-v',
        `${workspaceDescPath}:/workspace/.rover-workspace.json:Z,ro`
      );
    }

    // Mount download cache volumes (apt, pub, npm, etc.) to avoid
    // re-downloading the same packages across container runs.
    ensureDownloadCacheVolumes(ContainerBackend.Docker, projectConfig);
    dockerArgs.push(...getDownloadCacheMounts(projectConfig));

    // Get extra args from CLI options and project config, merge them
    const configExtraArgs = normalizeExtraArgs(projectConfig.sandboxExtraArgs);
    const cliExtraArgs = normalizeExtraArgs(this.options?.extraArgs);
    const extraArgs = [...configExtraArgs, ...cliExtraArgs];

    dockerArgs.push(
      ...envVariables,
      '-w',
      '/workspace',
      '--entrypoint',
      '/entrypoint.sh',
      ...extraArgs
    );

    if (this.initMode) {
      // Init-only container: run setup then exit successfully
      dockerArgs.push(effectiveImage, 'true');
    } else {
      dockerArgs.push(
        effectiveImage,
        'rover-agent',
        'run',
        '/workflow.yml',
        '--agent-tool',
        this.task.agent!,
        '--task-id',
        this.task.id.toString(),
        '--status-file',
        '/output/status.json',
        '--output',
        '/output',
        '--inputs-json',
        '/inputs.json'
      );

      // Pass context directory argument if context was mounted
      if (hasContext) {
        dockerArgs.push('--context-dir', '/context');
      }

      // Mount checkpoint if resuming from a paused workflow
      dockerArgs.push(...getCheckpointArgs(this.options?.checkpointPath));

      // Pass model if specified
      if (this.task.agentModel) {
        dockerArgs.push('--agent-model', this.task.agentModel);
      }

      // Forward verbose flag to rover-agent if enabled
      if (VERBOSE) {
        dockerArgs.push('-v');
      }
    }

    return (
      (await launch('docker', dockerArgs)).stdout?.toString().trim() ||
      this.sandboxName
    );
  }

  protected async start(): Promise<string> {
    return (
      (await launch('docker', ['start', this.sandboxName])).stdout
        ?.toString()
        .trim() || this.sandboxName
    );
  }

  /**
   * Pre-compute image cache state so createAndStart() can decide
   * whether to run a two-phase init before calling create().
   */
  private checkCacheState(): void {
    const projectConfig = ProjectConfigManager.load(
      this.options?.projectPath ?? process.cwd()
    );
    const agentImage = resolveAgentImage(projectConfig, this.task.agentImage);

    const { hasCachedImage, cacheTag } = checkImageCache(
      ContainerBackend.Docker,
      projectConfig,
      agentImage,
      this.task.agent!
    );

    this.cacheTag = cacheTag;
    this.shouldCommitCache = !hasCachedImage;
  }

  async createAndStart(): Promise<string> {
    this.checkCacheState();

    if (this.shouldCommitCache && this.cacheTag) {
      // Phase 1: init-only container to build the cached image
      this.initMode = true;
      this.processManager?.addItem(
        `Initialize sandbox (${this.backend}) | Name: ${this.sandboxName}`
      );
      try {
        await this.create();
        this.processManager?.completeLastItem();
        this.processManager?.addItem(
          `Run initialization (${this.backend}) | Name: ${this.sandboxName}`
        );
        await this.start();
        const committed = await waitForInitAndCommit(
          ContainerBackend.Docker,
          this.sandboxName,
          this.cacheTag,
          this.options?.projectPath ?? process.cwd(),
          this.task.agent,
          this.options?.sandboxMetadata
        );
        this.processManager?.completeLastItem();

        if (!committed) {
          this.processManager?.finish();
          throw new Error('Init container did not exit successfully');
        }
      } catch (err) {
        this.runTmpCleanups();
        this.initMode = false;
        this.processManager?.failLastItem();
        this.processManager?.finish();
        throw err;
      }

      // Phase 2: create + start the real container from cached image
      this.initMode = false;
      this.shouldCommitCache = false;
      this.cacheTag = undefined;
    }

    // Start service containers before the task container (runtime only, not during cache builds)
    const projectConfig = ProjectConfigManager.load(
      this.options?.projectPath ?? process.cwd()
    );
    const services = projectConfig.services;
    if (services && services.length > 0) {
      this.processManager?.addItem('Starting service containers...');
      const dockerEnv = this.getDockerEnv();
      try {
        const networkName = await createServiceNetwork(
          ContainerBackend.Docker,
          this.task.id,
          this.task.iterations,
          dockerEnv
        );
        this.serviceContext = {
          networkName,
          containerNames: [],
          taskId: this.task.id,
          iteration: this.task.iterations,
        };
        const containerNames = await startServiceContainers(
          ContainerBackend.Docker,
          services,
          networkName,
          this.task.id,
          this.task.iterations,
          dockerEnv,
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
          ContainerBackend.Docker,
          services,
          containerNames,
          dockerEnv
        );
        this.processManager?.completeLastItem();
      } catch (err) {
        this.processManager?.failLastItem();
        // Best-effort cleanup of any partially started services
        if (this.serviceContext) {
          await teardownServiceContainers(
            ContainerBackend.Docker,
            this.serviceContext,
            dockerEnv
          );
          this.serviceContext = undefined;
        }
        this.processManager?.finish();
        throw err;
      }
    }

    // Cache-hit path (or phase 2 after init)
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
      this.runTmpCleanups();
      if (this.serviceContext) {
        try {
          await teardownServiceContainers(
            ContainerBackend.Docker,
            this.serviceContext,
            this.getDockerEnv()
          );
        } catch {
          // Don't mask the original sandbox startup error with cleanup failures.
        }
        this.serviceContext = undefined;
      }
      this.processManager?.failLastItem();
      this.processManager?.finish();
      throw err;
    }
    this.processManager?.finish();
    return sandboxId;
  }

  async runInteractive(
    initialPrompt?: string
  ): Promise<ReturnType<typeof launch>> {
    // Start Docker container with direct stdio inheritance
    const iteration = this.task.getLastIteration();

    if (!iteration) {
      throw new Error('No iteration data found for this task');
    }

    // Load project configuration
    const projectConfig = ProjectConfigManager.load(
      this.options?.projectPath ?? process.cwd()
    );
    const worktreePath = this.task.worktreePath;

    validateSandboxWorktreePath(worktreePath, projectConfig);

    // Resolve the agent image from env var, stored task image, config, or default
    const agentImage = resolveAgentImage(projectConfig, this.task.agentImage);

    // Check image cache for interactive mode
    const { hasCachedImage, cacheTag } = checkImageCache(
      ContainerBackend.Docker,
      projectConfig,
      agentImage,
      this.task.agent!
    );

    const effectiveImage = hasCachedImage ? cacheTag : agentImage;

    if (hasCachedImage && !isJsonMode()) {
      console.log(
        colors.green('Using cached setup image ') + colors.cyan(cacheTag)
      );
    }

    // Generate setup script using SetupBuilder
    const setupBuilder = new SetupBuilder(
      this.task,
      this.task.agent!,
      projectConfig,
      { resumeFromCheckpoint: this.options?.resumeFromCheckpoint }
    );
    const entrypointScriptPath = setupBuilder.generateEntrypoint(
      false,
      'entrypoint-iterate.sh',
      hasCachedImage
    );
    // Get agent-specific Docker mounts and environment variables
    const agent = getAIAgentTool(this.task.agent!);
    const dockerMounts: string[] = agent.getContainerMounts();
    const envVariables: string[] = this.getSandboxEnvironmentVariables(
      agent,
      projectConfig
    );

    let startedInteractiveServices = false;

    try {
      // Start service containers for interactive mode
      const services = projectConfig.services;
      if (services && services.length > 0 && !this.serviceContext) {
        const dockerEnv = this.getDockerEnv();
        const networkName = await createServiceNetwork(
          ContainerBackend.Docker,
          this.task.id,
          this.task.iterations,
          dockerEnv
        );
        this.serviceContext = {
          networkName,
          containerNames: [],
          taskId: this.task.id,
          iteration: this.task.iterations,
        };
        startedInteractiveServices = true;
        const containerNames = await startServiceContainers(
          ContainerBackend.Docker,
          services,
          networkName,
          this.task.id,
          this.task.iterations,
          dockerEnv,
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
          ContainerBackend.Docker,
          services,
          containerNames,
          dockerEnv
        );
      }

      const interactiveName = `${this.sandboxName}-i`;
      const dockerArgs = ['run', '--name', interactiveName, '-it', '--rm'];

      // Attach to service network
      if (this.serviceContext) {
        dockerArgs.push(
          ...getServiceNetworkArgs(this.serviceContext.networkName)
        );
      }

      const rawUserInfoInteractive = userInfo();
      const userInfo_ = {
        ...rawUserInfoInteractive,
        uid:
          rawUserInfoInteractive.uid === -1 ? 1000 : rawUserInfoInteractive.uid,
        gid:
          rawUserInfoInteractive.gid === -1 ? 1000 : rawUserInfoInteractive.gid,
      };

      // Warn if using a custom agent image
      warnIfCustomImage(projectConfig);

      const {
        etcPasswd,
        etcGroup,
        cleanup: cleanupTmpFiles,
      } = await tmpUserGroupFiles(
        ContainerBackend.Docker,
        effectiveImage,
        userInfo_
      );
      this._tmpCleanups.push(cleanupTmpFiles);

      // Add NET_ADMIN capability if network filtering is configured
      const effectiveNetworkConfigInteractive = mergeNetworkConfig(
        projectConfig.network,
        this.task.networkConfig
      );
      if (
        effectiveNetworkConfigInteractive &&
        effectiveNetworkConfigInteractive.mode !== 'allowall'
      ) {
        dockerArgs.push('--cap-add=NET_ADMIN');
      }

      dockerArgs.push(
        '-v',
        `${etcPasswd}:/etc/passwd:Z,ro`,
        '-v',
        `${etcGroup}:/etc/group:Z,ro`,
        '--user',
        `${userInfo_.uid}:${userInfo_.gid}`,
        '-v',
        `${worktreePath}:/workspace:Z,rw`,
        ...getWorktreeGitMounts(worktreePath),
        '-v',
        `${iteration.iterationPath}:/output:Z,rw`,
        ...dockerMounts,
        '-v',
        `${entrypointScriptPath}:/entrypoint.sh:Z,ro`
      );

      // Mount context directory if available (read-only)
      const contextDir = join(iteration.iterationPath, 'context');
      const hasContext = existsSync(contextDir);
      if (hasContext) {
        dockerArgs.push('-v', `${contextDir}:/context:Z,ro`);
      }

      // Mount init scripts (root-only; project-scoped scripts run from cloned workspace)
      dockerArgs.push(...getInitScriptMounts(projectConfig));

      // Mount workspace description if projects are configured
      const workspaceDescPath = setupBuilder.generateWorkspaceDescription();
      if (workspaceDescPath) {
        dockerArgs.push(
          '-v',
          `${workspaceDescPath}:/workspace/.rover-workspace.json:Z,ro`
        );
      }

      // Mount download cache volumes for interactive mode too
      ensureDownloadCacheVolumes(ContainerBackend.Docker, projectConfig);
      dockerArgs.push(...getDownloadCacheMounts(projectConfig));

      // Get extra args from CLI options and project config, merge them
      const configExtraArgs = normalizeExtraArgs(
        projectConfig.sandboxExtraArgs
      );
      const cliExtraArgs = normalizeExtraArgs(this.options?.extraArgs);
      const extraArgs = [...configExtraArgs, ...cliExtraArgs];

      dockerArgs.push(
        ...envVariables,
        '-w',
        '/workspace',
        '--entrypoint',
        '/entrypoint.sh',
        ...extraArgs,
        effectiveImage,
        'rover-agent',
        'session',
        this.task.agent!
      );

      if (initialPrompt) {
        dockerArgs.push(initialPrompt);
      }

      // Pass context directory argument if context was mounted
      if (hasContext) {
        dockerArgs.push('--context-dir', '/context');
      }

      // Pass model if specified
      if (this.task.agentModel) {
        dockerArgs.push('--agent-model', this.task.agentModel);
      }

      // Forward verbose flag to rover-agent if enabled
      if (VERBOSE) {
        dockerArgs.push('-v');
      }

      // Use detached: false to ensure proper TTY signal handling and job control
      return await launch('docker', dockerArgs, {
        stdio: 'inherit',
        reject: false,
        detached: false,
      });
    } finally {
      if (startedInteractiveServices && this.serviceContext) {
        await teardownServiceContainers(
          ContainerBackend.Docker,
          this.serviceContext,
          this.getDockerEnv()
        );
        this.serviceContext = undefined;
      }
    }
  }

  /**
   * Get the environment object with DOCKER_HOST set if available from options.
   */
  private getDockerEnv(): NodeJS.ProcessEnv {
    const dockerHost = this.options?.sandboxMetadata?.dockerHost;
    if (typeof dockerHost === 'string') {
      return { ...process.env, DOCKER_HOST: dockerHost };
    }
    return process.env;
  }

  async inspect(): Promise<{ status: string; exitCode?: number } | null> {
    try {
      const result = await launch(
        'docker',
        [
          'inspect',
          '--format',
          '{{.State.Status}}|{{.State.ExitCode}}',
          this.sandboxName,
        ],
        { env: this.getDockerEnv() }
      );
      const output = result.stdout?.toString().trim();
      if (!output) return null;
      const [status, exitCodeStr] = output.split('|');
      const exitCode = exitCodeStr ? parseInt(exitCodeStr, 10) : undefined;
      if (!status) {
        return null;
      }

      const containerState = {
        status,
        exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
      };
      if (status !== 'running') {
        await this.teardownServicesIfConfigured();
      }

      return containerState;
    } catch (error) {
      if (isContainerMissingInspectError(error)) {
        return null;
      }
      throw error;
    }
  }

  protected async remove(): Promise<string> {
    const result =
      (
        await launch('docker', ['rm', '-f', this.sandboxName], {
          env: this.getDockerEnv(),
        })
      ).stdout
        ?.toString()
        .trim() || this.sandboxName;
    this.runTmpCleanups();
    return result;
  }

  protected async stop(): Promise<string> {
    return (
      (
        await launch('docker', ['stop', this.sandboxName], {
          env: this.getDockerEnv(),
        })
      ).stdout
        ?.toString()
        .trim() || this.sandboxName
    );
  }

  protected async logs(): Promise<string> {
    return (
      (
        await launch('docker', ['logs', this.sandboxName], {
          env: this.getDockerEnv(),
        })
      ).stdout?.toString() || ''
    );
  }

  protected async *followLogs(): AsyncIterable<string> {
    const child = launch('docker', ['logs', '--follow', this.sandboxName], {
      env: this.getDockerEnv(),
    });

    if (!child.stdout) {
      return;
    }

    // Stream stdout line by line, killing the child process on consumer exit
    try {
      for await (const chunk of child.stdout) {
        yield chunk.toString();
      }
    } finally {
      child.kill();
    }
  }

  async openShellAtWorktree(): Promise<void> {
    // Check if worktree exists
    if (!this.task.worktreePath || !existsSync(this.task.worktreePath)) {
      throw new Error('No worktree found for this task');
    }

    // Generate a unique container name for the interactive shell
    const containerName = `rover-shell-${this.task.id}-${generateRandomId()}`;

    // Get extra args from CLI options and project config, merge them
    const projectConfig = ProjectConfigManager.load(
      this.options?.projectPath ?? process.cwd()
    );
    const configExtraArgs = normalizeExtraArgs(projectConfig.sandboxExtraArgs);
    const cliExtraArgs = normalizeExtraArgs(this.options?.extraArgs);
    const extraArgs = [...configExtraArgs, ...cliExtraArgs];

    // Build Docker run command for interactive shell
    const dockerArgs = [
      'run',
      '--rm', // Remove container when it exits
      '-it', // Interactive with TTY
      '--name',
      containerName,
      '-v',
      `${this.task.worktreePath}:/workspace:Z,rw`,
      '-w',
      '/workspace',
      ...extraArgs,
      'node:lts',
      '/bin/bash',
    ];

    // Start Docker container with direct stdio inheritance for true interactivity
    // Use detached: false to ensure proper TTY signal handling and job control
    await launch('docker', dockerArgs, {
      reject: false,
      stdio: 'inherit', // This gives full control to the user
      detached: false,
    });
  }
}
