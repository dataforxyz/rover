import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('Firecracker Images', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ROVER_FIRECRACKER_CACHE_DIR;
    delete process.env.ROVER_FIRECRACKER_IMAGE_BASE_URL;
    delete process.env.ROVER_FIRECRACKER_KERNEL;
    delete process.env.ROVER_FIRECRACKER_ROOTFS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function importFirecrackerImages() {
    return await import('../firecracker-images.js');
  }

  describe('getFirecrackerCacheDir', () => {
    it('should return default cache directory', async () => {
      const { getFirecrackerCacheDir } = await importFirecrackerImages();
      const cacheDir = getFirecrackerCacheDir();
      expect(cacheDir).toBe(join(homedir(), '.cache', 'rover', 'firecracker'));
    });

    it('should respect ROVER_FIRECRACKER_CACHE_DIR env var', async () => {
      const customDir = join(homedir(), '.cache', 'rover-test-custom');
      process.env.ROVER_FIRECRACKER_CACHE_DIR = customDir;
      const { getFirecrackerCacheDir } = await importFirecrackerImages();
      const cacheDir = getFirecrackerCacheDir();
      expect(cacheDir).toBe(customDir);
    });
  });

  describe('getImageUrls', () => {
    it('should return default image URLs', async () => {
      const { getImageUrls } = await importFirecrackerImages();
      const urls = getImageUrls('1.0.0');

      expect(urls.kernel).toContain('firecracker-kernel-v1.0.0.bin');
      expect(urls.rootfs).toContain('firecracker-rootfs-v1.0.0.ext4');
    });

    it('should use latest for dev versions', async () => {
      const { getImageUrls } = await importFirecrackerImages();
      const urls = getImageUrls('1.0.0-dev');

      expect(urls.kernel).toContain('firecracker-kernel-latest.bin');
      expect(urls.rootfs).toContain('firecracker-rootfs-latest.ext4');
    });

    it('should respect custom base URL', async () => {
      process.env.ROVER_FIRECRACKER_IMAGE_BASE_URL =
        'https://custom.example.com/releases';
      const { getImageUrls } = await importFirecrackerImages();
      const urls = getImageUrls('1.0.0');

      expect(urls.kernel).toContain('https://custom.example.com/releases');
      expect(urls.rootfs).toContain('https://custom.example.com/releases');
    });
  });

  describe('generateVMConfig', () => {
    it('should generate valid VM configuration', async () => {
      const { generateVMConfig } = await importFirecrackerImages();

      const config = generateVMConfig({
        kernelPath: '/path/to/kernel.bin',
        rootfsPath: '/path/to/rootfs.ext4',
        vcpus: 2,
        memoryMb: 1024,
      });

      expect(config.kernelImagePath).toBe('/path/to/kernel.bin');
      expect(config.drives).toHaveLength(1);
      expect(config.drives[0].pathOnHost).toBe('/path/to/rootfs.ext4');
      expect(config.drives[0].isRootDevice).toBe(true);
      expect(config.machineConfig.vcpuCount).toBe(2);
      expect(config.machineConfig.memSizeMib).toBe(1024);
    });

    it('should include vsock config when provided', async () => {
      const { generateVMConfig } = await importFirecrackerImages();

      const config = generateVMConfig({
        kernelPath: '/path/to/kernel.bin',
        rootfsPath: '/path/to/rootfs.ext4',
        vsockCid: 3,
        vsockPath: '/path/to/vsock.sock',
      });

      expect(config.vsock).toBeDefined();
      expect(config.vsock?.guestCid).toBe(3);
      expect(config.vsock?.udsPath).toBe('/path/to/vsock.sock');
    });

    it('should use default values when not specified', async () => {
      const { generateVMConfig } = await importFirecrackerImages();

      const config = generateVMConfig({
        kernelPath: '/path/to/kernel.bin',
        rootfsPath: '/path/to/rootfs.ext4',
      });

      expect(config.machineConfig.vcpuCount).toBe(2);
      expect(config.machineConfig.memSizeMib).toBe(1024);
    });

    it('should include proper boot args', async () => {
      const { generateVMConfig } = await importFirecrackerImages();

      const config = generateVMConfig({
        kernelPath: '/path/to/kernel.bin',
        rootfsPath: '/path/to/rootfs.ext4',
      });

      expect(config.bootArgs).toContain('console=ttyS0');
      expect(config.bootArgs).toContain('init=/init');
    });
  });
});
