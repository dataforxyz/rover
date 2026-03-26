import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getWorkspaceDescriptionRepositories,
  getConfiguredWorkspaceRepositories,
  getWorkspaceRepositories,
} from '../workspace-repositories.js';

describe('workspace-repositories', () => {
  const testRoots: string[] = [];

  function makeTmpDir(): string {
    const rootDir = mkdtempSync(join(tmpdir(), 'rover-ws-repo-test-'));
    const worktreeDir = join(rootDir, 'workspace');
    mkdirSync(worktreeDir, { recursive: true });
    testRoots.push(rootDir);
    return worktreeDir;
  }

  function makeCentralTaskDirs(): {
    rootDir: string;
    taskDir: string;
    worktreeDir: string;
  } {
    const rootDir = mkdtempSync(join(tmpdir(), 'rover-ws-repo-central-test-'));
    const taskDir = join(rootDir, 'tasks', '42');
    const worktreeDir = join(rootDir, 'workspaces', '42');
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    testRoots.push(rootDir);
    return { rootDir, taskDir, worktreeDir };
  }

  function makeIterationDir(worktreeDir: string, iteration: number): string {
    const iterationDir = join(
      worktreeDir,
      '..',
      'iterations',
      iteration.toString()
    );
    mkdirSync(iterationDir, { recursive: true });
    return iterationDir;
  }

  afterEach(() => {
    for (const rootDir of testRoots) {
      rmSync(rootDir, { recursive: true, force: true });
    }
    testRoots.length = 0;
  });

  // ── getWorkspaceDescriptionRepositories ───────────────────────────

  describe('getWorkspaceDescriptionRepositories', () => {
    it('returns empty array when no persisted description exists', () => {
      const dir = makeTmpDir();
      expect(getWorkspaceDescriptionRepositories(dir)).toEqual([]);
    });

    it('returns empty array for malformed persisted JSON', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        'not json {{{'
      );
      expect(getWorkspaceDescriptionRepositories(dir)).toEqual([]);
    });

    it('falls back to the newest parseable persisted description', () => {
      const dir = makeTmpDir();
      const olderIterationDir = makeIterationDir(dir, 1);
      const latestIterationDir = makeIterationDir(dir, 2);
      writeFileSync(
        join(latestIterationDir, 'workspace-description.json'),
        'not json {{{'
      );
      writeFileSync(
        join(olderIterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'frontend',
              path: 'frontend',
              repository: 'https://example.com/frontend.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toEqual([
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: join(dir, 'frontend'),
          repository: 'https://example.com/frontend.git',
          ref: undefined,
        },
      ]);
    });

    it('returns empty array when projects is not an array', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({ projects: 'not-an-array' })
      );
      expect(getWorkspaceDescriptionRepositories(dir)).toEqual([]);
    });

    it('filters out projects missing required fields', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'valid',
              path: 'valid-path',
              repository: 'https://example.com/repo.git',
            },
            {
              name: 'missing-path',
              repository: 'https://example.com/repo.git',
            },
            {
              path: 'missing-name',
              repository: 'https://example.com/repo.git',
            },
            { name: 'missing-repo', path: 'some-path' },
            {
              name: 123,
              path: 'num-name',
              repository: 'https://example.com/repo.git',
            },
            null,
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid');
    });

    it('parses valid workspace description correctly', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 2);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'frontend',
              path: 'frontend',
              repository: 'https://github.com/org/frontend.git',
              ref: 'main',
            },
            {
              name: 'backend',
              path: 'backend',
              repository: 'https://github.com/org/backend.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'frontend',
        relativePath: 'frontend',
        worktreePath: join(dir, 'frontend'),
        repository: 'https://github.com/org/frontend.git',
        ref: 'main',
      });
      expect(result[1]).toEqual({
        name: 'backend',
        relativePath: 'backend',
        worktreePath: join(dir, 'backend'),
        repository: 'https://github.com/org/backend.git',
        ref: undefined,
      });
    });

    it('ignores non-string ref values', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'app',
              path: 'app',
              repository: 'https://example.com/app.git',
              ref: 42,
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result[0].ref).toBeUndefined();
    });

    it('prefers the latest persisted iteration description over legacy worktree metadata', () => {
      const dir = makeTmpDir();
      const olderIterationDir = makeIterationDir(dir, 1);
      const latestIterationDir = makeIterationDir(dir, 2);

      writeFileSync(
        join(dir, '.rover-workspace.json'),
        JSON.stringify({
          projects: [
            {
              name: 'legacy',
              path: 'legacy',
              repository: 'https://example.com/legacy.git',
            },
          ],
        })
      );

      writeFileSync(
        join(olderIterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'older',
              path: 'older',
              repository: 'https://example.com/older.git',
            },
          ],
        })
      );

      writeFileSync(
        join(latestIterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'latest',
              path: 'latest',
              repository: 'https://example.com/latest.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('latest');
    });

    it('falls back to the newest iteration that actually has persisted metadata', () => {
      const dir = makeTmpDir();
      const olderIterationDir = makeIterationDir(dir, 1);
      makeIterationDir(dir, 2);

      writeFileSync(
        join(olderIterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'older',
              path: 'older',
              repository: 'https://example.com/older.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('older');
    });

    it('falls back to legacy worktree metadata when persisted iteration metadata is absent', () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, '.rover-workspace.json'),
        JSON.stringify({
          projects: [
            {
              name: 'legacy',
              path: 'legacy',
              repository: 'https://example.com/legacy.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('legacy');
    });

    it('reads persisted metadata from the task directory for centralized workspaces', () => {
      const { taskDir, worktreeDir } = makeCentralTaskDirs();
      const iterationDir = join(taskDir, 'iterations', '3');
      mkdirSync(iterationDir, { recursive: true });
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'frontend',
              path: 'frontend',
              repository: 'https://example.com/frontend.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(worktreeDir, taskDir);
      expect(result).toEqual([
        {
          name: 'frontend',
          relativePath: 'frontend',
          worktreePath: join(worktreeDir, 'frontend'),
          repository: 'https://example.com/frontend.git',
          ref: undefined,
        },
      ]);
    });
  });

  // ── path traversal protection ─────────────────────────────────────

  describe('path traversal protection', () => {
    it('rejects projects with path traversal in workspace description', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'escape',
              path: '../../etc',
              repository: 'https://example.com/evil.git',
            },
            {
              name: 'safe',
              path: 'frontend',
              repository: 'https://example.com/safe.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('safe');
    });

    it('rejects projects with absolute paths in workspace description', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'abs',
              path: '/tmp/evil',
              repository: 'https://example.com/evil.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toHaveLength(0);
    });

    it('rejects projects whose path escapes through a symlink in workspace description', () => {
      const dir = makeTmpDir();
      const outsideRepo = mkdtempSync(join(tmpdir(), 'rover-ws-outside-'));
      testRoots.push(outsideRepo);
      symlinkSync(outsideRepo, join(dir, 'services'));

      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        JSON.stringify({
          projects: [
            {
              name: 'escaped',
              path: 'services/api',
              repository: 'https://example.com/evil.git',
            },
          ],
        })
      );

      const result = getWorkspaceDescriptionRepositories(dir);
      expect(result).toEqual([]);
    });

    it('rejects projects with path traversal in project config', () => {
      const dir = makeTmpDir();
      const config = {
        projects: [
          {
            name: 'escape',
            path: '../../../etc/passwd',
            repository: 'https://example.com/evil.git',
          },
          {
            name: 'safe',
            path: 'backend',
            repository: 'https://example.com/safe.git',
          },
        ],
      } as any;

      const result = getConfiguredWorkspaceRepositories(dir, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('safe');
    });

    it('rejects configured projects whose path escapes through a symlink', () => {
      const dir = makeTmpDir();
      const outsideRepo = mkdtempSync(join(tmpdir(), 'rover-ws-outside-'));
      testRoots.push(outsideRepo);
      symlinkSync(outsideRepo, join(dir, 'services'));

      const config = {
        projects: [
          {
            name: 'escaped',
            path: 'services/api',
            repository: 'https://example.com/evil.git',
          },
        ],
      } as any;

      const result = getConfiguredWorkspaceRepositories(dir, config);
      expect(result).toEqual([]);
    });
  });

  // ── getConfiguredWorkspaceRepositories ────────────────────────────

  describe('getConfiguredWorkspaceRepositories', () => {
    it('returns empty array when projectConfig has no projects', () => {
      const dir = makeTmpDir();
      const config = { projects: undefined } as any;
      expect(getConfiguredWorkspaceRepositories(dir, config)).toEqual([]);
    });

    it('filters projects without repository field', () => {
      const dir = makeTmpDir();
      const config = {
        projects: [
          {
            name: 'has-repo',
            path: 'a',
            repository: 'https://example.com/a.git',
          },
          { name: 'no-repo', path: 'b' },
        ],
      } as any;

      const result = getConfiguredWorkspaceRepositories(dir, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('has-repo');
    });

    it('maps project config entries to WorkspaceRepository shape', () => {
      const dir = makeTmpDir();
      const config = {
        projects: [
          {
            name: 'svc',
            path: 'services/svc',
            repository: 'git@github.com:org/svc.git',
            ref: 'develop',
          },
        ],
      } as any;

      const result = getConfiguredWorkspaceRepositories(dir, config);
      expect(result[0]).toEqual({
        name: 'svc',
        relativePath: 'services/svc',
        worktreePath: join(dir, 'services/svc'),
        repository: 'git@github.com:org/svc.git',
        ref: 'develop',
      });
    });
  });

  // ── getWorkspaceRepositories (priority fallback) ──────────────────

  describe('getWorkspaceRepositories', () => {
    it('prefers workspace description over project config', () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, '.rover-workspace.json'),
        JSON.stringify({
          projects: [
            {
              name: 'from-description',
              path: 'desc',
              repository: 'https://example.com/desc.git',
            },
          ],
        })
      );

      const config = {
        projects: [
          {
            name: 'from-config',
            path: 'cfg',
            repository: 'https://example.com/cfg.git',
          },
        ],
      } as any;

      const result = getWorkspaceRepositories(dir, dir, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('from-description');
    });

    it('falls back to project config when no description file exists', () => {
      const dir = makeTmpDir();
      const config = {
        projects: [
          {
            name: 'from-config',
            path: 'cfg',
            repository: 'https://example.com/cfg.git',
          },
        ],
      } as any;

      const result = getWorkspaceRepositories(dir, dir, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('from-config');
    });

    it('preserves a root-only workspace when description file has empty projects', () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, '.rover-workspace.json'),
        JSON.stringify({ projects: [] })
      );

      const config = {
        projects: [
          {
            name: 'fallback',
            path: 'fb',
            repository: 'https://example.com/fb.git',
          },
        ],
      } as any;

      const result = getWorkspaceRepositories(dir, dirname(dir), config);
      expect(result).toEqual([]);
    });

    it('preserves a legacy root-only task when iterations exist without workspace descriptions', () => {
      const dir = makeTmpDir();
      makeIterationDir(dir, 1);

      const config = {
        projects: [
          {
            name: 'fallback',
            path: 'fb',
            repository: 'https://example.com/fb.git',
          },
        ],
      } as any;

      const result = getWorkspaceRepositories(dir, dirname(dir), config);
      expect(result).toEqual([]);
    });

    it('does not infer current config when persisted workspace metadata is malformed', () => {
      const dir = makeTmpDir();
      const iterationDir = makeIterationDir(dir, 1);
      writeFileSync(
        join(iterationDir, 'workspace-description.json'),
        'not json {{{'
      );

      const config = {
        projects: [
          {
            name: 'fallback',
            path: 'fb',
            repository: 'https://example.com/fb.git',
          },
        ],
      } as any;

      const result = getWorkspaceRepositories(dir, dirname(dir), config);
      expect(result).toEqual([]);
    });
  });
});
