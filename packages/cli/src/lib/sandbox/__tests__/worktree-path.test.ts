import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from 'rover-core';
import { validateSandboxWorktreePath } from '../worktree-path.js';

function createProjectConfig(projectRoot: string): ProjectConfig {
  return {
    version: '1.2',
    projectRoot,
    language: 'typescript',
    languages: [],
    mcps: [],
    packageManagers: [],
    taskManagers: [],
    attribution: true,
    allInitScripts: [],
  } as ProjectConfig;
}

describe('validateSandboxWorktreePath', () => {
  it('accepts a worktree under a symlinked project root', () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'rover-worktree-real-'));
    const linkedParent = mkdtempSync(join(tmpdir(), 'rover-worktree-link-'));
    const symlinkRoot = join(linkedParent, 'project-link');
    const worktreePath = join(realRoot, '.rover', 'tasks', '1', 'workspace');

    try {
      mkdirSync(worktreePath, { recursive: true });
      symlinkSync(realRoot, symlinkRoot, 'dir');

      expect(
        validateSandboxWorktreePath(
          worktreePath,
          createProjectConfig(symlinkRoot)
        )
      ).toBe(worktreePath);
    } finally {
      rmSync(linkedParent, { recursive: true, force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });
});
