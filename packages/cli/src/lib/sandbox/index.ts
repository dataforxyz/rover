export * from './types.js';
export * from './config.js';
export { DockerSandbox } from './docker.js';
export { PodmanSandbox } from './podman.js';
export { FirecrackerSandbox } from './firecracker.js';
export * from './firecracker-images.js';

import { DockerSandbox } from './docker.js';
import { PodmanSandbox } from './podman.js';
import { FirecrackerSandbox } from './firecracker.js';
import { Sandbox } from './types.js';
import { TaskDescriptionManager, ProcessManager } from 'rover-core';
import {
  loadSandboxConfig,
  isGVisorAvailable,
  isKVMAvailable,
  isFirecrackerAvailable,
  type SecurityLevel,
} from './config.js';

/**
 * Available sandbox backend types
 */
export type SandboxBackend =
  | 'docker'
  | 'docker-gvisor'
  | 'podman'
  | 'firecracker'
  | null;

/**
 * Information about the available sandbox backend
 */
export interface SandboxBackendInfo {
  backend: SandboxBackend;
  securityLevel: SecurityLevel;
  gvisorAvailable: boolean;
  firecrackerAvailable: boolean;
  kvmAvailable: boolean;
}

/**
 * Get the available sandbox backend
 * Priority: Firecracker (if KVM + maximum security) > Docker+gVisor > Docker > Podman
 * @returns The name of the available backend or null if none available
 */
export async function getAvailableSandboxBackend(): Promise<SandboxBackend> {
  const config = loadSandboxConfig();

  // Check for forced backend
  if (config.forceBackend === 'firecracker') {
    const firecrackerSandbox = new FirecrackerSandbox(
      {} as TaskDescriptionManager
    );
    if (await firecrackerSandbox.isBackendAvailable()) {
      return 'firecracker';
    }
    throw new Error(
      'Firecracker backend requested but not available. Ensure KVM is accessible and Firecracker is installed.'
    );
  }

  // Check for Firecracker when maximum security is requested
  if (config.securityLevel === 'maximum') {
    const firecrackerSandbox = new FirecrackerSandbox(
      {} as TaskDescriptionManager
    );
    if (await firecrackerSandbox.isBackendAvailable()) {
      return 'firecracker';
    }
    // Fall through to other backends if Firecracker not available
  }

  // Try Docker first
  const dockerSandbox = new DockerSandbox({} as TaskDescriptionManager);
  if (await dockerSandbox.isBackendAvailable()) {
    // Check if gVisor is available for enhanced security
    if (
      config.securityLevel === 'enhanced' ||
      config.forceBackend === 'gvisor'
    ) {
      const gvisorAvailable = await isGVisorAvailable();
      if (gvisorAvailable) {
        return 'docker-gvisor';
      }
    }
    return 'docker';
  }

  // Try Podman as fallback
  const podmanSandbox = new PodmanSandbox({} as TaskDescriptionManager);
  if (await podmanSandbox.isBackendAvailable()) {
    return 'podman';
  }

  return null;
}

/**
 * Get detailed information about available sandbox backends
 */
export async function getSandboxBackendInfo(): Promise<SandboxBackendInfo> {
  const config = loadSandboxConfig();
  const gvisorAvailable = await isGVisorAvailable();
  const kvmAvailable = await isKVMAvailable();
  const firecrackerAvailable = await isFirecrackerAvailable();

  // Check for Firecracker first (maximum security)
  if (
    kvmAvailable &&
    firecrackerAvailable &&
    (config.securityLevel === 'maximum' ||
      config.forceBackend === 'firecracker')
  ) {
    return {
      backend: 'firecracker',
      securityLevel: 'maximum',
      gvisorAvailable,
      firecrackerAvailable: true,
      kvmAvailable: true,
    };
  }

  // Try Docker
  const dockerSandbox = new DockerSandbox({} as TaskDescriptionManager);
  if (await dockerSandbox.isBackendAvailable()) {
    const useGVisor =
      gvisorAvailable &&
      (config.securityLevel === 'enhanced' || config.forceBackend === 'gvisor');

    return {
      backend: useGVisor ? 'docker-gvisor' : 'docker',
      securityLevel: useGVisor ? 'enhanced' : 'standard',
      gvisorAvailable,
      firecrackerAvailable,
      kvmAvailable,
    };
  }

  // Try Podman as fallback
  const podmanSandbox = new PodmanSandbox({} as TaskDescriptionManager);
  if (await podmanSandbox.isBackendAvailable()) {
    return {
      backend: 'podman',
      securityLevel: 'standard', // Podman doesn't support gVisor
      gvisorAvailable: false,
      firecrackerAvailable,
      kvmAvailable,
    };
  }

  return {
    backend: null,
    securityLevel: 'standard',
    gvisorAvailable: false,
    firecrackerAvailable,
    kvmAvailable,
  };
}

/**
 * Create a sandbox instance using the best available backend
 * Priority: Firecracker (if KVM + maximum security) > Docker+gVisor > Docker > Podman
 * @param task The task description
 * @param processManager Optional process manager for progress tracking
 * @returns A Sandbox instance
 * @throws Error if no backend is available
 */
export async function createSandbox(
  task: TaskDescriptionManager,
  processManager?: ProcessManager
): Promise<Sandbox> {
  const config = loadSandboxConfig();

  // Check for forced Firecracker backend
  if (config.forceBackend === 'firecracker') {
    const firecrackerSandbox = new FirecrackerSandbox(task, processManager);
    if (await firecrackerSandbox.isBackendAvailable()) {
      return firecrackerSandbox;
    }
    throw new Error(
      'Firecracker backend requested but not available. Ensure KVM is accessible and Firecracker is installed.'
    );
  }

  // Check for Firecracker when maximum security is requested
  if (config.securityLevel === 'maximum') {
    const firecrackerSandbox = new FirecrackerSandbox(task, processManager);
    if (await firecrackerSandbox.isBackendAvailable()) {
      return firecrackerSandbox;
    }
    // Fall through to other backends if Firecracker not available
    console.warn(
      'Maximum security requested but Firecracker not available. Falling back to Docker.'
    );
  }

  // Try Docker first (priority)
  const dockerSandbox = new DockerSandbox(task, processManager);
  if (await dockerSandbox.isBackendAvailable()) {
    return dockerSandbox;
  }

  // Try Podman as fallback
  const podmanSandbox = new PodmanSandbox(task, processManager);
  if (await podmanSandbox.isBackendAvailable()) {
    return podmanSandbox;
  }

  // Neither backend is available
  throw new Error(
    'No sandbox backend available. Please install Docker, Podman, or Firecracker to run tasks.'
  );
}
