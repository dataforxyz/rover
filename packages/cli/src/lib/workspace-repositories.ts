import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfigManager } from 'rover-core';
import { resolvePathWithinRoot } from '../utils/path-safety.js';

export interface WorkspaceRepository {
  name: string;
  relativePath: string;
  worktreePath: string;
  repository: string;
  ref?: string;
}

interface WorkspaceDescriptionProject {
  name?: unknown;
  path?: unknown;
  repository?: unknown;
  ref?: unknown;
}

interface WorkspaceDescription {
  projects?: WorkspaceDescriptionProject[];
}

interface WorkspaceDescriptionLookupResult {
  foundPersistedState: boolean;
  repositories: WorkspaceRepository[];
}

function getIterationWorkspaceDescriptionPaths(taskBasePath: string): {
  iterationCount: number;
  descriptionPaths: string[];
} {
  const iterationsPath = join(taskBasePath, 'iterations');

  if (!existsSync(iterationsPath)) {
    return { iterationCount: 0, descriptionPaths: [] };
  }

  const iterationIds = readdirSync(iterationsPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => Number.parseInt(dirent.name, 10))
    .filter(iteration => !Number.isNaN(iteration))
    .sort((a, b) => b - a);

  return {
    iterationCount: iterationIds.length,
    descriptionPaths: iterationIds.flatMap(iterationId => {
      const descriptionPath = join(
        iterationsPath,
        iterationId.toString(),
        'workspace-description.json'
      );
      return existsSync(descriptionPath) ? [descriptionPath] : [];
    }),
  };
}

function parseWorkspaceDescription(
  descriptionPath: string,
  taskWorktreePath: string
): WorkspaceRepository[] | undefined {
  try {
    const raw = readFileSync(descriptionPath, 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceDescription;
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];

    return projects
      .map<WorkspaceRepository | null>(project => {
        if (
          typeof project?.name !== 'string' ||
          typeof project?.path !== 'string' ||
          typeof project?.repository !== 'string'
        ) {
          return null;
        }
        const resolvedPath = resolvePathWithinRoot(
          taskWorktreePath,
          project.path as string
        );
        if (resolvedPath === null) {
          return null;
        }
        return {
          name: project.name as string,
          relativePath: project.path as string,
          worktreePath: resolvedPath,
          repository: project.repository as string,
          ...(typeof project.ref === 'string' ? { ref: project.ref } : {}),
        };
      })
      .filter((entry): entry is WorkspaceRepository => entry !== null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Warning: failed to parse workspace description at ${descriptionPath}: ${message}\n`
    );
    return undefined;
  }
}

function getWorkspaceDescriptionRepositoriesResult(
  taskWorktreePath: string,
  taskBasePath: string = dirname(taskWorktreePath)
): WorkspaceDescriptionLookupResult {
  const { iterationCount, descriptionPaths: persistedDescriptionPaths } =
    getIterationWorkspaceDescriptionPaths(taskBasePath);
  let foundPersistedState = persistedDescriptionPaths.length > 0;

  for (const descriptionPath of persistedDescriptionPaths) {
    const repositories = parseWorkspaceDescription(
      descriptionPath,
      taskWorktreePath
    );
    if (repositories !== undefined) {
      return { foundPersistedState: true, repositories };
    }
  }

  const legacyDescriptionPath = join(taskWorktreePath, '.rover-workspace.json');
  if (!existsSync(legacyDescriptionPath)) {
    return { foundPersistedState, repositories: [] };
  }

  foundPersistedState = true;
  return {
    foundPersistedState,
    repositories:
      parseWorkspaceDescription(legacyDescriptionPath, taskWorktreePath) ?? [],
  };
}

export function getWorkspaceDescriptionRepositories(
  taskWorktreePath: string,
  taskBasePath: string = dirname(taskWorktreePath)
): WorkspaceRepository[] {
  return getWorkspaceDescriptionRepositoriesResult(
    taskWorktreePath,
    taskBasePath
  ).repositories;
}

export function getConfiguredWorkspaceRepositories(
  taskWorktreePath: string,
  projectConfig: ProjectConfigManager
): WorkspaceRepository[] {
  return (projectConfig.projects ?? [])
    .map<WorkspaceRepository | null>(project => {
      if (
        typeof project.name !== 'string' ||
        typeof project.path !== 'string' ||
        typeof project.repository !== 'string'
      ) {
        return null;
      }
      const resolvedPath = resolvePathWithinRoot(
        taskWorktreePath,
        project.path
      );
      if (resolvedPath === null) {
        return null;
      }
      return {
        name: project.name,
        relativePath: project.path,
        worktreePath: resolvedPath,
        repository: project.repository,
        ...(typeof project.ref === 'string' ? { ref: project.ref } : {}),
      };
    })
    .filter((entry): entry is WorkspaceRepository => entry !== null);
}

export function getWorkspaceRepositories(
  taskWorktreePath: string,
  taskBasePath: string,
  projectConfig: ProjectConfigManager
): WorkspaceRepository[] {
  const fromDescription = getWorkspaceDescriptionRepositoriesResult(
    taskWorktreePath,
    taskBasePath
  );
  if (fromDescription.foundPersistedState) {
    return fromDescription.repositories;
  }

  return getConfiguredWorkspaceRepositories(taskWorktreePath, projectConfig);
}
