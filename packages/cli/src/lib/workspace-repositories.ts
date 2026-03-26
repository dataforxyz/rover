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

function getLatestIterationWorkspaceDescriptionPath(
  taskBasePath: string
): string | undefined {
  const iterationsPath = join(taskBasePath, 'iterations');

  if (!existsSync(iterationsPath)) {
    return undefined;
  }

  const latestIteration = readdirSync(iterationsPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => Number.parseInt(dirent.name, 10))
    .filter(iteration => !Number.isNaN(iteration))
    .sort((a, b) => b - a)[0];

  if (latestIteration === undefined) {
    return undefined;
  }

  const descriptionPath = join(
    iterationsPath,
    latestIteration.toString(),
    'workspace-description.json'
  );

  return existsSync(descriptionPath) ? descriptionPath : undefined;
}

function parseWorkspaceDescription(
  descriptionPath: string,
  taskWorktreePath: string
): WorkspaceRepository[] {
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
  } catch {
    return [];
  }
}

export function getWorkspaceDescriptionRepositories(
  taskWorktreePath: string,
  taskBasePath: string = dirname(taskWorktreePath)
): WorkspaceRepository[] {
  const persistedDescriptionPath =
    getLatestIterationWorkspaceDescriptionPath(taskBasePath);
  if (persistedDescriptionPath) {
    return parseWorkspaceDescription(
      persistedDescriptionPath,
      taskWorktreePath
    );
  }

  const legacyDescriptionPath = join(taskWorktreePath, '.rover-workspace.json');
  if (!existsSync(legacyDescriptionPath)) {
    return [];
  }

  return parseWorkspaceDescription(legacyDescriptionPath, taskWorktreePath);
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
  const fromDescription = getWorkspaceDescriptionRepositories(
    taskWorktreePath,
    taskBasePath
  );
  if (fromDescription.length > 0) {
    return fromDescription;
  }

  return getConfiguredWorkspaceRepositories(taskWorktreePath, projectConfig);
}
