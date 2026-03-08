import { realpathSync } from 'node:fs';
import { getDataDir, type ProjectConfig } from 'rover-core';
import { isPathWithin } from '../../utils/path-utils.js';

function normalizeKnownRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function validateSandboxWorktreePath(
  worktreePath: string,
  projectConfig: ProjectConfig
): string {
  let realWorktreePath: string;
  try {
    realWorktreePath = realpathSync(worktreePath);
  } catch {
    throw new Error(
      `Invalid worktree path for this project (${worktreePath}): path does not exist`
    );
  }

  const realProjectRoot = normalizeKnownRoot(projectConfig.projectRoot);
  const realDataDir = normalizeKnownRoot(getDataDir());
  const worktreeKnownLocation =
    isPathWithin(realWorktreePath, realProjectRoot) ||
    isPathWithin(realWorktreePath, realDataDir);

  if (realWorktreePath.length === 0 || !worktreeKnownLocation) {
    throw new Error(`Invalid worktree path for this project (${worktreePath})`);
  }

  return realWorktreePath;
}
