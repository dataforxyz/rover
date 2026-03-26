import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateBuildEntrypoint,
  prepareBuildProjectConfig,
} from '../build.js';

describe('generateBuildEntrypoint', () => {
  const testDirs: string[] = [];

  afterEach(() => {
    for (const dir of testDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  it('clones child repos and runs root plus project init scripts during cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [
        { script: 'scripts/system-init.sh' },
        { path: 'frontend', script: 'scripts/init.sh' },
        { path: 'backend', script: 'scripts/init.sh' },
      ],
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
        },
        {
          name: 'backend',
          path: 'backend',
          repository: 'https://github.com/dataforxyz/backend.git',
        },
      ],
      mcps: [],
    } as any);

    expect(script).toContain('cp -a /workspace-src/. "$BUILD_WORKSPACE/"');
    expect(script).toContain('Syncing external repositories for cache build');
    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/frontend.git' '/workspace/frontend'"
    );
    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/backend.git' '/workspace/backend'"
    );
    expect(script).toContain(
      "git -C '/workspace/frontend' fetch --all --tags --prune"
    );
    expect(script).toContain(
      "git -C '/workspace/backend' fetch --all --tags --prune"
    );
    expect(script).toContain("git -C '/workspace/frontend' clean -fdx");
    expect(script).toContain("git -C '/workspace/backend' clean -fdx");
    expect(script).toContain('bash "/workspace/scripts/system-init.sh"');
    expect(script).toContain(
      "workspace_project_script_1='/workspace/frontend/scripts/init.sh'"
    );
    expect(script).toContain(
      "workspace_project_script_2='/workspace/backend/scripts/init.sh'"
    );
    expect(script).toContain('bash "$workspace_script_1"');
    expect(script).toContain('bash "$workspace_script_2"');
  });

  it('copies credentials before syncing child repositories for cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [],
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'git@github.com:dataforxyz/frontend.git',
          packageManagers: ['npm'],
        },
      ],
      mcps: [],
    } as any);

    const credentialInstallIndex = script.indexOf(
      'run_as_root rover-agent-install $AGENT || true'
    );
    const repoSyncIndex = script.indexOf(
      'Syncing external repositories for cache build'
    );
    const dependencyResolutionIndex = script.indexOf(
      "cd '/workspace/frontend' && npm install 2>/dev/null || true"
    );

    expect(credentialInstallIndex).toBeGreaterThanOrEqual(0);
    expect(repoSyncIndex).toBeGreaterThan(credentialInstallIndex);
    expect(dependencyResolutionIndex).toBeGreaterThan(repoSyncIndex);
  });

  it('uses helper wrappers so cache builds still work when sudo is unavailable', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [],
      projects: [],
      mcps: [],
    } as any);

    expect(script).toContain('run_as_root() {');
    expect(script).toContain('run_as_root_with_env() {');
    expect(script).toContain(
      'run_as_root_with_env rover-agent install $AGENT || echo "Agent install failed (non-fatal for build)"'
    );
    expect(script).not.toContain('$_SUDO -E rover-agent install $AGENT');
  });

  it('syncs child repositories before installing languages for cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: ['go'],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [],
      projects: [
        {
          name: 'backend',
          path: 'backend',
          repository: 'https://github.com/dataforxyz/backend.git',
          languages: ['go'],
        },
      ],
      mcps: [],
    } as any);

    const repoSyncIndex = script.indexOf(
      'Syncing external repositories for cache build'
    );
    const installGoIndex = script.indexOf('Installing go...');
    const goVersionProbeIndex = script.indexOf(
      'if [ -f /workspace/go.mod ]; then'
    );

    expect(repoSyncIndex).toBeGreaterThanOrEqual(0);
    expect(installGoIndex).toBeGreaterThan(repoSyncIndex);
    expect(goVersionProbeIndex).toBeGreaterThan(repoSyncIndex);
  });

  it('runs init scripts before resolving dependencies during cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [{ script: 'scripts/system-init.sh' }],
      packageManagers: ['uv'],
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['pnpm'],
        },
      ],
      mcps: [],
    } as any);

    const initScriptIndex = script.indexOf(
      'bash "/workspace/scripts/system-init.sh"'
    );
    const rootDependencyIndex = script.indexOf("cd '/workspace' && uv sync");
    const projectDependencyIndex = script.indexOf(
      "cd '/workspace/frontend' && pnpm install"
    );

    expect(initScriptIndex).toBeGreaterThanOrEqual(0);
    expect(rootDependencyIndex).toBeGreaterThan(initScriptIndex);
    expect(projectDependencyIndex).toBeGreaterThan(initScriptIndex);
  });

  it('filters unsafe project and init-script paths from cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [
        { script: 'scripts/system-init.sh' },
        { path: '../../escape', script: 'scripts/bad.sh' },
        { path: 'frontend', script: 'scripts/init.sh' },
      ],
      projects: [
        {
          name: 'unsafe',
          path: '../../escape',
          repository: 'https://github.com/dataforxyz/unsafe.git',
        },
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
        },
      ],
      mcps: [],
      projectRoot: '/repo',
    } as any);

    expect(script).toContain('/workspace/frontend');
    expect(script).not.toContain('/workspace/../../escape');
    expect(script).not.toContain('scripts/bad.sh');
  });

  it('prefers project-relative init scripts during cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [{ path: 'frontend', script: 'scripts/init.sh' }],
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
        },
      ],
      mcps: [],
      projectRoot: '/repo',
    } as any);

    expect(script).toContain(
      "workspace_root_script_0='/workspace/scripts/init.sh'"
    );
    expect(script).toContain(
      "workspace_project_script_0='/workspace/frontend/scripts/init.sh'"
    );
    expect(script).toContain("workspace_dir_0='/workspace/frontend'");
    expect(script).toContain('if [ -f "$workspace_project_script_0" ]; then');
    expect(script).toContain('bash "$workspace_script_0"');
  });

  it('rewrites local child repositories to mounted container paths for cache builds', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const { buildProjectConfig, repositoryMounts } = prepareBuildProjectConfig(
      root,
      {
        projects: [
          {
            name: 'frontend',
            path: 'frontend',
            repository: './repos/frontend.git',
          },
        ],
      } as any
    );

    expect(repositoryMounts).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/0',
      },
    ]);
    expect(buildProjectConfig.projects?.[0]?.repository).toBe(
      '/workspace-repos/0'
    );
  });

  it('fails early when a configured local child repository is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    testDirs.push(root);

    expect(() =>
      prepareBuildProjectConfig(root, {
        projects: [
          {
            name: 'frontend',
            path: 'frontend',
            repository: './repos/frontend.git',
          },
        ],
      } as any)
    ).toThrow(/Local workspace repository for frontend not found/);
  });
});
