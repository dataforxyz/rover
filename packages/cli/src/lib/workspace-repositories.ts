import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfigManager } from 'rover-core';

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
  taskWorktreePath: string
): string | undefined {
  const taskBasePath = dirname(taskWorktreePath);
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
      .filter(
        (
          project
        ): project is {
          name: string;
          path: string;
          repository: string;
          ref?: string;
        } =>
          typeof project?.name === 'string' &&
          typeof project?.path === 'string' &&
          typeof project?.repository === 'string'
      )
      .map(project => ({
        name: project.name,
        relativePath: project.path,
        worktreePath: join(taskWorktreePath, project.path),
        repository: project.repository,
        ref: typeof project.ref === 'string' ? project.ref : undefined,
      }));
  } catch {
    return [];
  }
}

export function getWorkspaceDescriptionRepositories(
  taskWorktreePath: string
): WorkspaceRepository[] {
  const persistedDescriptionPath =
    getLatestIterationWorkspaceDescriptionPath(taskWorktreePath);
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
    .filter(
      (
        project
      ): project is {
        name: string;
        path: string;
        repository: string;
        ref?: string;
      } =>
        typeof project.name === 'string' &&
        typeof project.path === 'string' &&
        typeof project.repository === 'string'
    )
    .map(project => ({
      name: project.name,
      relativePath: project.path,
      worktreePath: join(taskWorktreePath, project.path),
      repository: project.repository,
      ref: project.ref,
    }));
}

export function getWorkspaceRepositories(
  taskWorktreePath: string,
  projectConfig: ProjectConfigManager
): WorkspaceRepository[] {
  const fromDescription = getWorkspaceDescriptionRepositories(taskWorktreePath);
  if (fromDescription.length > 0) {
    return fromDescription;
  }

  return getConfiguredWorkspaceRepositories(taskWorktreePath, projectConfig);
}
