import { existsSync, mkdirSync, createWriteStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launch } from 'rover-core';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Firecracker image paths and metadata.
 */
export interface FirecrackerImages {
  /** Path to the Linux kernel image */
  kernelPath: string;
  /** Path to the root filesystem image */
  rootfsPath: string;
  /** Version of the images */
  version: string;
}

/**
 * Get the Rover CLI version for image versioning.
 */
function getCLIVersion(): string {
  try {
    const packageJsonPath = join(__dirname, '../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return 'latest';
  }
}

/**
 * Get the cache directory for Firecracker images.
 */
export function getFirecrackerCacheDir(): string {
  const cacheDir =
    process.env.ROVER_FIRECRACKER_CACHE_DIR ||
    join(homedir(), '.cache', 'rover', 'firecracker');

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  return cacheDir;
}

/**
 * Get the expected image URLs for the current CLI version.
 */
export function getImageUrls(version?: string): {
  kernel: string;
  rootfs: string;
} {
  const ver = version || getCLIVersion();
  const baseUrl =
    process.env.ROVER_FIRECRACKER_IMAGE_BASE_URL ||
    'https://github.com/endorhq/rover/releases/download';

  // For dev versions, use latest
  const imageVersion = ver.includes('-dev') ? 'latest' : `v${ver}`;

  return {
    kernel: `${baseUrl}/${imageVersion}/firecracker-kernel-${imageVersion}.bin`,
    rootfs: `${baseUrl}/${imageVersion}/firecracker-rootfs-${imageVersion}.ext4`,
  };
}

/**
 * Check if images are already cached and valid.
 */
export function areImagesCached(version?: string): boolean {
  const cacheDir = getFirecrackerCacheDir();
  const ver = version || getCLIVersion();
  const imageVersion = ver.includes('-dev') ? 'latest' : `v${ver}`;

  const kernelPath = join(cacheDir, `kernel-${imageVersion}.bin`);
  const rootfsPath = join(cacheDir, `rootfs-${imageVersion}.ext4`);

  if (!existsSync(kernelPath) || !existsSync(rootfsPath)) {
    return false;
  }

  // Check if files are non-empty
  try {
    const kernelStats = statSync(kernelPath);
    const rootfsStats = statSync(rootfsPath);
    return kernelStats.size > 0 && rootfsStats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Download a file from URL to local path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  // Create parent directory if needed
  const dir = dirname(destPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Use curl or wget for downloading (more reliable than Node's http)
  try {
    await launch('curl', ['-fsSL', '-o', destPath, url], { stdio: 'pipe' });
  } catch {
    // Fallback to wget
    try {
      await launch('wget', ['-q', '-O', destPath, url], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(
        `Failed to download ${url}. Ensure curl or wget is installed.`
      );
    }
  }
}

/**
 * Download Firecracker images if not already cached.
 * Returns paths to kernel and rootfs images.
 */
export async function ensureFirecrackerImages(
  version?: string
): Promise<FirecrackerImages> {
  const cacheDir = getFirecrackerCacheDir();
  const ver = version || getCLIVersion();
  const imageVersion = ver.includes('-dev') ? 'latest' : `v${ver}`;

  const kernelPath = join(cacheDir, `kernel-${imageVersion}.bin`);
  const rootfsPath = join(cacheDir, `rootfs-${imageVersion}.ext4`);

  // Check if already cached
  if (areImagesCached(ver)) {
    return {
      kernelPath,
      rootfsPath,
      version: imageVersion,
    };
  }

  // Download images
  const urls = getImageUrls(ver);

  console.log(`Downloading Firecracker kernel image...`);
  await downloadFile(urls.kernel, kernelPath);

  console.log(`Downloading Firecracker rootfs image...`);
  await downloadFile(urls.rootfs, rootfsPath);

  return {
    kernelPath,
    rootfsPath,
    version: imageVersion,
  };
}

/**
 * Get paths to Firecracker images, downloading if necessary.
 * This is the main entry point for getting images.
 */
export async function getFirecrackerImages(
  version?: string
): Promise<FirecrackerImages> {
  // Check for local override paths
  const localKernel = process.env.ROVER_FIRECRACKER_KERNEL;
  const localRootfs = process.env.ROVER_FIRECRACKER_ROOTFS;

  if (localKernel && localRootfs) {
    if (!existsSync(localKernel)) {
      throw new Error(
        `ROVER_FIRECRACKER_KERNEL path does not exist: ${localKernel}`
      );
    }
    if (!existsSync(localRootfs)) {
      throw new Error(
        `ROVER_FIRECRACKER_ROOTFS path does not exist: ${localRootfs}`
      );
    }
    return {
      kernelPath: localKernel,
      rootfsPath: localRootfs,
      version: 'local',
    };
  }

  // Download or use cached images
  return ensureFirecrackerImages(version);
}

/**
 * Firecracker VM configuration.
 */
export interface FirecrackerVMConfig {
  /** Path to kernel image */
  kernelImagePath: string;
  /** Kernel boot arguments */
  bootArgs: string;
  /** Root drive configuration */
  drives: Array<{
    driveId: string;
    pathOnHost: string;
    isRootDevice: boolean;
    isReadOnly: boolean;
  }>;
  /** Machine configuration */
  machineConfig: {
    vcpuCount: number;
    memSizeMib: number;
  };
  /** Network interfaces (optional) */
  networkInterfaces?: Array<{
    ifaceId: string;
    guestMac?: string;
    hostDevName: string;
  }>;
  /** Vsock configuration for host-guest communication */
  vsock?: {
    guestCid: number;
    udsPath: string;
  };
}

/**
 * Generate Firecracker VM configuration JSON.
 */
export function generateVMConfig(options: {
  kernelPath: string;
  rootfsPath: string;
  workspacePath?: string;
  outputPath?: string;
  vcpus?: number;
  memoryMb?: number;
  networkEnabled?: boolean;
  vsockCid?: number;
  vsockPath?: string;
}): FirecrackerVMConfig {
  const {
    kernelPath,
    rootfsPath,
    vcpus = 2,
    memoryMb = 1024,
    networkEnabled = false,
    vsockCid,
    vsockPath,
  } = options;

  const config: FirecrackerVMConfig = {
    kernelImagePath: kernelPath,
    bootArgs:
      'console=ttyS0 reboot=k panic=1 pci=off init=/init ro quiet loglevel=1',
    drives: [
      {
        driveId: 'rootfs',
        pathOnHost: rootfsPath,
        isRootDevice: true,
        isReadOnly: false, // Need write access for agent operations
      },
    ],
    machineConfig: {
      vcpuCount: vcpus,
      memSizeMib: memoryMb,
    },
  };

  // Add vsock for host-guest communication if configured
  if (vsockCid && vsockPath) {
    config.vsock = {
      guestCid: vsockCid,
      udsPath: vsockPath,
    };
  }

  return config;
}

/**
 * Create a writable overlay for the rootfs.
 * This allows multiple VMs to share the same base rootfs.
 */
export async function createRootfsOverlay(
  baseRootfs: string,
  overlayPath: string,
  sizeMb: number = 1024
): Promise<string> {
  // Create a sparse file for the overlay
  await launch('dd', [
    'if=/dev/zero',
    `of=${overlayPath}`,
    'bs=1M',
    `count=0`,
    `seek=${sizeMb}`,
  ]);

  // Format as ext4
  await launch('mkfs.ext4', ['-F', overlayPath]);

  return overlayPath;
}
