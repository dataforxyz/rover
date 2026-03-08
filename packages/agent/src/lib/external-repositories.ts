import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { launchSync } from 'rover-core';

interface WorkspaceProject {
  name?: unknown;
  path?: unknown;
  repository?: unknown;
}

interface WorkspaceDescription {
  projects?: WorkspaceProject[];
}

export interface ExternalRepositoryState {
  name: string;
  path: string;
  repository: string;
  head: string;
  trackedDiffHash: string;
  untrackedHash: string;
}

const DEFAULT_WORKSPACE_PATH = '/workspace';
const DEFAULT_DESCRIPTION_PATH = join(
  DEFAULT_WORKSPACE_PATH,
  '.rover-workspace.json'
);

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitOutput(repoPath: string, args: string[]): string {
  return (
    launchSync('git', args, {
      cwd: repoPath,
      reject: false,
      stdio: 'pipe',
    }).stdout?.toString() ?? ''
  ).trimEnd();
}

/**
 * Stream-hash a single file to avoid loading its entire contents into memory.
 * Falls back to readFileSync for small files (< 1 MB) where the overhead of
 * creating a read stream is not worthwhile.
 */
function hashFileIntoDigest(
  hash: ReturnType<typeof createHash>,
  fullPath: string,
  size: number,
): void {
  const STREAM_THRESHOLD = 1 * 1024 * 1024; // 1 MB
  if (size < STREAM_THRESHOLD) {
    hash.update(readFileSync(fullPath));
    return;
  }
  // Synchronous chunked read to avoid loading large files into memory.
  // Acceptable because checkpoint capture already runs synchronously
  // in a signal handler context.
  const fd = openSync(fullPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}

function computeUntrackedHash(repoPath: string): string {
  const raw = launchSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    {
      cwd: repoPath,
      reject: false,
      stdio: 'pipe',
    }
  ).stdout;
  const entries = (raw?.toString() ?? '')
    .split('\0')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const hash = createHash('sha256');
  for (const relativePath of entries) {
    const fullPath = join(repoPath, relativePath);
    hash.update(relativePath);
    hash.update('\0');

    if (!existsSync(fullPath)) {
      hash.update('missing\0');
      continue;
    }

    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(fullPath));
      hash.update('\0');
      continue;
    }

    if (stat.isFile()) {
      // Skip files larger than 50 MB to avoid OOM on large binary artifacts
      if (stat.size > 50 * 1024 * 1024) {
        hash.update('large_file\0');
        hash.update(String(stat.size));
        hash.update('\0');
        continue;
      }
      hash.update('file\0');
      hashFileIntoDigest(hash, fullPath, stat.size);
      hash.update('\0');
      continue;
    }

    if (stat.isDirectory()) {
      hash.update('dir\0');
      continue;
    }

    hash.update('other\0');
  }

  return hash.digest('hex');
}

export function captureExternalRepositoryStates(
  workspacePath: string = DEFAULT_WORKSPACE_PATH,
  descriptionPath: string = DEFAULT_DESCRIPTION_PATH
): ExternalRepositoryState[] {
  if (!existsSync(descriptionPath)) {
    return [];
  }

  let description: WorkspaceDescription;
  try {
    description = JSON.parse(
      readFileSync(descriptionPath, 'utf8')
    ) as WorkspaceDescription;
  } catch {
    console.warn(`Warning: Failed to parse workspace description at ${descriptionPath}`);
    return [];
  }
  const projects = Array.isArray(description.projects)
    ? description.projects
    : [];

  return projects
    .filter(
      (
        project
      ): project is { name: string; path: string; repository: string } =>
        typeof project?.name === 'string' &&
        typeof project?.path === 'string' &&
        typeof project?.repository === 'string'
    )
    .map(project => {
      const repoPath = join(workspacePath, project.path);
      return {
        name: project.name,
        path: project.path,
        repository: project.repository,
        head: gitOutput(repoPath, ['rev-parse', 'HEAD']),
        trackedDiffHash: sha256Hex(
          gitOutput(repoPath, ['diff', '--binary', 'HEAD', '--no-ext-diff'])
        ),
        untrackedHash: computeUntrackedHash(repoPath),
      };
    });
}
