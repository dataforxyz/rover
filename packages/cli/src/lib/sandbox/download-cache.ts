import { launch, launchSync, ProjectConfigManager, VERBOSE } from 'rover-core';
import { ContainerBackend } from './container-common.js';

const VOLUME_PREFIX = 'rover-dlcache';

interface DownloadCacheEntry {
  /** Docker/Podman named volume name */
  volume: string;
  /** Path inside the container where the volume is mounted */
  containerPath: string;
}

/**
 * Mapping from language/package-manager names to download cache volumes.
 * Each cache is included when any of its trigger names appear in the
 * project's configured languages or package managers. Entries with an
 * empty triggers array are always included.
 *
 * Volumes persist download artifacts (apt .debs, pub/npm/go packages)
 * across container runs so that repeated builds and tasks avoid
 * re-downloading the same files from the network.
 */
const CACHE_DEFINITIONS: Array<{
  triggers: string[];
  volume: string;
  containerPath: string;
}> = [
  {
    triggers: [], // always included — every build uses apt
    volume: `${VOLUME_PREFIX}-apt`,
    containerPath: '/var/cache/apt',
  },
  {
    triggers: ['dart'],
    volume: `${VOLUME_PREFIX}-pub`,
    containerPath: '/home/agent/.pub-cache',
  },
  {
    triggers: ['javascript', 'typescript', 'npm'],
    volume: `${VOLUME_PREFIX}-npm`,
    containerPath: '/home/agent/.npm',
  },
  {
    triggers: ['pnpm'],
    volume: `${VOLUME_PREFIX}-pnpm`,
    containerPath: '/home/agent/.local/share/pnpm/store',
  },
  {
    triggers: ['yarn'],
    volume: `${VOLUME_PREFIX}-yarn`,
    containerPath: '/home/agent/.cache/yarn',
  },
  {
    triggers: ['go', 'gomod'],
    volume: `${VOLUME_PREFIX}-go`,
    containerPath: '/home/agent/go/pkg/mod',
  },
  {
    triggers: ['pip', 'poetry', 'uv', 'python'],
    volume: `${VOLUME_PREFIX}-pip`,
    containerPath: '/home/agent/.cache/pip',
  },
  {
    triggers: ['rust', 'cargo'],
    volume: `${VOLUME_PREFIX}-cargo`,
    containerPath: '/home/agent/.cargo/registry',
  },
];

/**
 * Determine which download cache volumes are needed based on project config.
 */
export function getDownloadCacheEntries(
  projectConfig: ProjectConfigManager
): DownloadCacheEntry[] {
  const languages = new Set(
    projectConfig.allLanguages ?? projectConfig.languages ?? []
  );
  const packageManagers = new Set(
    projectConfig.allPackageManagers ?? projectConfig.packageManagers ?? []
  );
  const allNames = new Set([...languages, ...packageManagers]);

  const entries: DownloadCacheEntry[] = [];

  for (const def of CACHE_DEFINITIONS) {
    if (
      def.triggers.length === 0 ||
      def.triggers.some(t => allNames.has(t))
    ) {
      entries.push({ volume: def.volume, containerPath: def.containerPath });
    }
  }

  return entries;
}

/**
 * Return Docker/Podman `-v` args for mounting download cache volumes.
 */
export function getDownloadCacheMounts(
  projectConfig: ProjectConfigManager
): string[] {
  const entries = getDownloadCacheEntries(projectConfig);
  const args: string[] = [];

  for (const entry of entries) {
    args.push('-v', `${entry.volume}:${entry.containerPath}:rw`);
  }

  return args;
}

/**
 * Ensure all needed download cache volumes exist.
 * Docker/Podman auto-create named volumes on first use, but creating
 * them explicitly avoids races when multiple containers start in parallel.
 */
export function ensureDownloadCacheVolumes(
  backend: ContainerBackend,
  projectConfig: ProjectConfigManager
): void {
  const entries = getDownloadCacheEntries(projectConfig);
  for (const entry of entries) {
    try {
      launchSync(backend, ['volume', 'create', entry.volume], {
        reject: false,
      });
    } catch {
      // Volume may already exist — that's fine
    }
  }
}

/**
 * List all rover download cache volume names on the given backend.
 */
export async function listDownloadCacheVolumes(
  backend: ContainerBackend,
  sandboxMetadata?: Record<string, unknown>
): Promise<string[]> {
  const dockerHost = sandboxMetadata?.dockerHost;
  const env =
    typeof dockerHost === 'string'
      ? { ...process.env, DOCKER_HOST: dockerHost }
      : undefined;
  const opts = env ? { env } : undefined;

  try {
    const result = await launch(
      backend,
      [
        'volume',
        'ls',
        '--filter',
        `name=${VOLUME_PREFIX}`,
        '--format',
        '{{.Name}}',
      ],
      opts
    );
    const stdout = result.stdout?.toString().trim() || '';
    if (!stdout) return [];
    return stdout.split('\n').filter(line => line.trim());
  } catch {
    return [];
  }
}

/**
 * Remove all rover download cache volumes.
 * Returns the names of volumes that were successfully removed.
 */
export async function removeDownloadCacheVolumes(
  backend: ContainerBackend,
  sandboxMetadata?: Record<string, unknown>
): Promise<string[]> {
  const volumes = await listDownloadCacheVolumes(backend, sandboxMetadata);
  const removed: string[] = [];

  const dockerHost = sandboxMetadata?.dockerHost;
  const env =
    typeof dockerHost === 'string'
      ? { ...process.env, DOCKER_HOST: dockerHost }
      : undefined;
  const opts = env ? { env } : undefined;

  for (const vol of volumes) {
    try {
      await launch(backend, ['volume', 'rm', '-f', vol], opts);
      removed.push(vol);
    } catch {
      if (VERBOSE) {
        console.warn(
          `Warning: Failed to remove download cache volume: ${vol}`
        );
      }
    }
  }

  return removed;
}
