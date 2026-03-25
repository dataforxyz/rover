import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export function getWorkspaceDescriptionRepositories(
  taskWorktreePath: string
): WorkspaceRepository[] {
  const descriptionPath = join(taskWorktreePath, '.rover-workspace.json');
  if (!existsSync(descriptionPath)) {
    return [];
  }

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
