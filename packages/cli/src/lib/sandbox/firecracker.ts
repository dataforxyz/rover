import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { ChildProcess, spawn } from 'node:child_process';
import { ProjectConfigManager, TaskDescriptionManager } from 'rover-core';
import { Sandbox } from './types.js';
import { launch, ProcessManager, VERBOSE } from 'rover-core';
import {
  loadSandboxConfig,
  isKVMAvailable,
  isFirecrackerAvailable,
  type SandboxConfig,
} from './config.js';
import {
  getFirecrackerImages,
  generateVMConfig,
  getFirecrackerCacheDir,
  type FirecrackerVMConfig,
} from './firecracker-images.js';

/**
 * Firecracker microVM sandbox for maximum security isolation.
 * Provides hardware-level isolation using KVM virtualization.
 *
 * Requirements:
 * - Linux with KVM support (/dev/kvm accessible)
 * - Firecracker binary installed
 * - Sufficient permissions (user in kvm group)
 */
export class FirecrackerSandbox extends Sandbox {
  backend = 'firecracker';
  protected sandboxConfig: SandboxConfig;
  protected vmProcess: ChildProcess | null = null;
  protected vmSocketPath: string = '';
  protected vmConfigPath: string = '';
  protected vmLogPath: string = '';
  protected vsockPath: string = '';

  constructor(task: TaskDescriptionManager, processManager?: ProcessManager) {
    super(task, processManager);
    this.sandboxConfig = loadSandboxConfig();
  }

  /**
   * Check if Firecracker backend is available.
   * Requires Linux with KVM and Firecracker binary.
   */
  async isBackendAvailable(): Promise<boolean> {
    const kvmAvailable = await isKVMAvailable();
    const firecrackerAvailable = await isFirecrackerAvailable();
    return kvmAvailable && firecrackerAvailable;
  }

  /**
   * Get the effective security level being used.
   */
  getEffectiveSecurityLevel(): string {
    return 'maximum (Firecracker microVM)';
  }

  /**
   * Get the VM runtime directory for this task.
   */
  protected getVMRuntimeDir(): string {
    const runtimeDir = join(
      getFirecrackerCacheDir(),
      'runtime',
      `task-${this.task.id}-${this.task.iterations}`
    );
    if (!existsSync(runtimeDir)) {
      mkdirSync(runtimeDir, { recursive: true });
    }
    return runtimeDir;
  }

  /**
   * Create the Firecracker microVM.
   */
  protected async create(): Promise<string> {
    const iteration = this.task.getLastIteration();

    if (!iteration) {
      throw new Error('No iteration data found for this task');
    }

    // Load project configuration
    const projectConfig = ProjectConfigManager.load();
    const worktreePath = this.task.worktreePath;

    if (
      worktreePath.length === 0 ||
      !worktreePath.startsWith(projectConfig.projectRoot)
    ) {
      throw new Error(
        `Invalid worktree path for this project (${worktreePath})`
      );
    }

    // Ensure Firecracker images are available
    const images = await getFirecrackerImages();

    // Set up runtime directory
    const runtimeDir = this.getVMRuntimeDir();
    this.vmSocketPath = join(runtimeDir, 'firecracker.sock');
    this.vmConfigPath = join(runtimeDir, 'vm-config.json');
    this.vmLogPath = join(runtimeDir, 'firecracker.log');
    this.vsockPath = join(runtimeDir, 'vsock.sock');

    // Clean up any existing socket
    if (existsSync(this.vmSocketPath)) {
      unlinkSync(this.vmSocketPath);
    }

    // Parse memory limit from config
    const memoryMb = this.parseMemoryLimit(
      this.sandboxConfig.resources.memory || '1024m'
    );
    const vcpus = parseInt(this.sandboxConfig.resources.cpus || '2', 10);

    // Generate VM configuration
    const vmConfig = generateVMConfig({
      kernelPath: images.kernelPath,
      rootfsPath: images.rootfsPath,
      workspacePath: worktreePath,
      outputPath: iteration.iterationPath,
      vcpus: vcpus,
      memoryMb: memoryMb,
      networkEnabled: this.sandboxConfig.networkMode !== 'none',
      vsockCid: 3, // Guest CID for vsock communication
      vsockPath: this.vsockPath,
    });

    // Write VM configuration
    writeFileSync(this.vmConfigPath, JSON.stringify(vmConfig, null, 2));

    // Create metadata file with task info for the VM to read
    const metadataPath = join(runtimeDir, 'metadata.json');
    writeFileSync(
      metadataPath,
      JSON.stringify({
        taskId: this.task.id,
        iteration: this.task.iterations,
        agent: this.task.agent,
        agentModel: this.task.agentModel,
        workspacePath: '/workspace',
        outputPath: '/output',
        verbose: VERBOSE,
      })
    );

    return this.sandboxName;
  }

  /**
   * Parse memory limit string to megabytes.
   */
  protected parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)([gmk])?$/i);
    if (!match) {
      return 1024; // Default 1GB
    }

    const value = parseInt(match[1], 10);
    const unit = (match[2] || 'm').toLowerCase();

    switch (unit) {
      case 'g':
        return value * 1024;
      case 'k':
        return Math.ceil(value / 1024);
      case 'm':
      default:
        return value;
    }
  }

  /**
   * Start the Firecracker microVM.
   */
  protected async start(): Promise<string> {
    const runtimeDir = this.getVMRuntimeDir();

    // Build Firecracker command
    const firecrackerArgs = [
      '--api-sock',
      this.vmSocketPath,
      '--config-file',
      this.vmConfigPath,
    ];

    if (VERBOSE) {
      firecrackerArgs.push('--log-path', this.vmLogPath, '--level', 'Debug');
    }

    // Start Firecracker process
    this.vmProcess = spawn('firecracker', firecrackerArgs, {
      cwd: runtimeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Store PID for later cleanup
    const pidPath = join(runtimeDir, 'firecracker.pid');
    if (this.vmProcess.pid) {
      writeFileSync(pidPath, this.vmProcess.pid.toString());
    }

    // Wait for socket to be ready
    await this.waitForSocket(this.vmSocketPath, 10000);

    return this.sandboxName;
  }

  /**
   * Wait for the Firecracker API socket to be ready.
   */
  protected async waitForSocket(
    socketPath: string,
    timeoutMs: number
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (existsSync(socketPath)) {
        // Try to connect to verify it's ready
        try {
          await this.sendVMCommand('GET', '/');
          return;
        } catch {
          // Socket exists but not ready yet
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(
      `Firecracker socket not ready after ${timeoutMs}ms: ${socketPath}`
    );
  }

  /**
   * Send a command to the Firecracker API.
   */
  protected async sendVMCommand(
    method: string,
    path: string,
    body?: object
  ): Promise<any> {
    const args = [
      '--unix-socket',
      this.vmSocketPath,
      '-X',
      method,
      `http://localhost${path}`,
    ];

    if (body) {
      args.push('-H', 'Content-Type: application/json');
      args.push('-d', JSON.stringify(body));
    }

    const result = await launch('curl', args, { stdio: 'pipe' });
    const output = result.stdout?.toString().trim();

    if (output) {
      try {
        return JSON.parse(output);
      } catch {
        return output;
      }
    }
    return null;
  }

  /**
   * Run interactive session (not fully supported for Firecracker).
   * For now, this falls back to a warning and basic functionality.
   */
  async runInteractive(
    _initialPrompt?: string
  ): Promise<ReturnType<typeof launch>> {
    throw new Error(
      'Interactive mode is not yet supported for Firecracker sandboxes. ' +
        'Use ROVER_SANDBOX_BACKEND=docker for interactive sessions.'
    );
  }

  /**
   * Stop the Firecracker microVM.
   */
  protected async stop(): Promise<string> {
    const runtimeDir = this.getVMRuntimeDir();
    const pidPath = join(runtimeDir, 'firecracker.pid');

    // Try graceful shutdown via API first
    try {
      await this.sendVMCommand('PUT', '/actions', {
        action_type: 'SendCtrlAltDel',
      });
      // Wait a moment for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch {
      // API might not be available
    }

    // Kill the process if still running
    if (existsSync(pidPath)) {
      try {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(pid, 'SIGTERM');

        // Wait for termination
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Force kill if still running
        try {
          process.kill(pid, 0); // Check if still running
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already terminated
        }
      } catch {
        // Process might already be gone
      }
    }

    // Kill via process handle if available
    if (this.vmProcess && !this.vmProcess.killed) {
      this.vmProcess.kill('SIGKILL');
    }

    return this.sandboxName;
  }

  /**
   * Remove the Firecracker microVM and cleanup.
   */
  protected async remove(): Promise<string> {
    await this.stop();

    // Clean up runtime directory
    const runtimeDir = this.getVMRuntimeDir();
    if (existsSync(runtimeDir)) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }

    return this.sandboxName;
  }

  /**
   * Get logs from the Firecracker microVM.
   */
  protected async logs(): Promise<string> {
    if (existsSync(this.vmLogPath)) {
      return readFileSync(this.vmLogPath, 'utf-8');
    }
    return '';
  }

  /**
   * Follow logs from the Firecracker microVM.
   */
  protected async *followLogs(): AsyncIterable<string> {
    // For Firecracker, we read from the log file
    // This is a simple implementation - could be improved with inotify
    let lastPosition = 0;

    while (true) {
      if (existsSync(this.vmLogPath)) {
        const content = readFileSync(this.vmLogPath, 'utf-8');
        if (content.length > lastPosition) {
          yield content.slice(lastPosition);
          lastPosition = content.length;
        }
      }

      // Check if VM is still running
      const runtimeDir = this.getVMRuntimeDir();
      const pidPath = join(runtimeDir, 'firecracker.pid');
      if (existsSync(pidPath)) {
        try {
          const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
          process.kill(pid, 0); // Check if running
        } catch {
          // Process terminated
          break;
        }
      } else {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Open a shell at the worktree (not supported for Firecracker).
   */
  async openShellAtWorktree(): Promise<void> {
    throw new Error(
      'Shell access is not yet supported for Firecracker sandboxes. ' +
        'Use ROVER_SANDBOX_BACKEND=docker for shell access.'
    );
  }
}
