import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getWorkspaceDescriptionRepositories,
  getConfiguredWorkspaceRepositories,
  getWorkspaceRepositories,
} from '../workspace-repositories.js';

describe('workspace-repositories', () => {
  const testDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rover-ws-repo-test-'));
    testDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of testDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  // ── getWorkspaceDescriptionRepositories ───────────────────────────

  describe('getWorkspaceDescriptionRepositories', () => {
    it('returns empty array when .rover-workspace.json does not exist', () => {
      const dir = makeTmpDir();
      expect(getWorkspaceDescriptionRepositories(dir)).toEqual([]);
    });

    it('returns empty array for malformed JSON', () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, '.rover-workspace.json'), 'not json {{{');
      expect(getWorkspaceDescriptionRepositories(dir)).toEqual([]);
    });

    it('returns empty array when projects is not an array', () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, '.rover-workspace.json'),
        JSON.stringify({ projects: 'not-an-array' })
      );
      expect(getWorkspaceDescriptionRepositories(dir)).toEqual([]);
    });

    it('filters out projects missing required fields', () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, '.rover-workspace.json'),
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
      writeFileSync(
        join(dir, '.rover-workspace.json'),
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
      writeFileSync(
        join(dir, '.rover-workspace.json'),
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

      const result = getWorkspaceRepositories(dir, config);
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

      const result = getWorkspaceRepositories(dir, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('from-config');
    });

    it('falls back to project config when description file has empty projects', () => {
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

      const result = getWorkspaceRepositories(dir, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('fallback');
    });
  });
});
