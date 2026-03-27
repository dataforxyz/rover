import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectConfigManager } from 'rover-core';
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
    expect(script).toContain("mounted_script_0='/init-script-0.sh'");
    expect(script).toContain(
      "workspace_script_0='/workspace/scripts/system-init.sh'"
    );
    expect(script).toContain('bash "$root_script_0"');
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

  it('falls back to root init scripts for project-scoped entries during cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [{ path: 'frontend', script: 'scripts/init.sh' }],
      projects: [],
      mcps: [],
    } as any);

    expect(script).toContain(
      "workspace_project_script_0='/workspace/frontend/scripts/init.sh'"
    );
    expect(script).toContain(
      "workspace_root_script_0='/workspace/scripts/init.sh'"
    );
    expect(script).toContain('elif [ -f "$workspace_root_script_0" ]; then');
    expect(script).toContain("workspace_dir_0='/workspace'");
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
    const installGoIndex = script.indexOf(
      'echo "Installing Go $GO_VERSION_DL ($GOARCH)..."'
    );
    const goVersionProbeIndex = script.indexOf(
      "for go_mod_path in '/workspace/go.mod' '/workspace/src/go.mod' '/workspace/backend/go.mod' '/workspace/backend/src/go.mod'; do"
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

    const initScriptIndex = script.indexOf('bash "$root_script_0"');
    const rootDependencyIndex = script.indexOf("cd '/workspace' && uv sync");
    const projectDependencyIndex = script.indexOf(
      "cd '/workspace/frontend' && pnpm install"
    );

    expect(initScriptIndex).toBeGreaterThanOrEqual(0);
    expect(rootDependencyIndex).toBeGreaterThan(initScriptIndex);
    expect(projectDependencyIndex).toBeGreaterThan(initScriptIndex);
  });

  it('runs root init scripts from mounted host paths during cache builds', () => {
    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [{ script: '../shared/system-init.sh' }],
      projects: [],
      mcps: [],
    } as any);

    expect(script).toContain("mounted_script_0='/init-script.sh'");
    expect(script).toContain(
      "workspace_script_0='/workspace/../shared/system-init.sh'"
    );
    expect(script).toContain('if [ -f "$mounted_script_0" ]; then');
    expect(script).toContain('bash "$root_script_0"');
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

  it('filters project-scoped init scripts whose path escapes through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'rover-build-outside-'));
    testDirs.push(root);
    testDirs.push(outside);
    symlinkSync(outside, join(root, 'services'));

    const script = generateBuildEntrypoint('claude', {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      allInitScripts: [{ path: 'services/api', script: 'scripts/init.sh' }],
      projects: [],
      mcps: [],
      projectRoot: root,
    } as any);

    expect(script).not.toContain('/workspace/services/api/scripts/init.sh');
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
      "workspace_project_script_0='/workspace/frontend/scripts/init.sh'"
    );
    expect(script).toContain("workspace_dir_0='/workspace/frontend'");
    expect(script).toContain('if [ -f "$workspace_project_script_0" ]; then');
    expect(script).toContain(
      'echo "❌ Initialization script (frontend) not found at $workspace_project_script_0 or $workspace_root_script_0"'
    );
    expect(script).toContain('bash "$workspace_script_0"');
    expect(script).toContain(
      "workspace_root_script_0='/workspace/scripts/init.sh'"
    );
  });

  it('rewrites local child repositories to mounted container paths for cache builds', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const { buildProjectConfig, repositoryMounts } = prepareBuildProjectConfig(
      root,
      new ProjectConfigManager(
        {
          version: '1.2',
          languages: [],
          mcps: [],
          packageManagers: ['uv'],
          taskManagers: [],
          attribution: true,
          sandbox: {
            initScript: 'scripts/system-init.sh',
          },
          projects: [
            {
              name: 'frontend',
              path: 'frontend',
              repository: './repos/frontend.git',
              packageManagers: ['pnpm'],
              initScript: 'scripts/init.sh',
            },
          ],
        } as any,
        root
      )
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
    expect(buildProjectConfig).toBeInstanceOf(ProjectConfigManager);
    expect(buildProjectConfig.packageManagers).toEqual(['uv']);
    expect(buildProjectConfig.allPackageManagers).toEqual(['uv', 'pnpm']);
    expect(buildProjectConfig.allInitScripts).toEqual([
      { script: 'scripts/system-init.sh' },
      { path: 'frontend', script: 'scripts/init.sh' },
    ]);
  });

  it('fails early when a configured local child repository is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    testDirs.push(root);

    expect(() =>
      prepareBuildProjectConfig(
        root,
        new ProjectConfigManager(
          {
            version: '1.2',
            languages: [],
            mcps: [],
            packageManagers: [],
            taskManagers: [],
            attribution: true,
            projects: [
              {
                name: 'frontend',
                path: 'frontend',
                repository: './repos/frontend.git',
              },
            ],
          } as any,
          root
        )
      )
    ).toThrow(/Local workspace repository for frontend not found/);
  });

  it('does not rewrite absolute container repository paths during build config preparation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    testDirs.push(root);

    const { buildProjectConfig, repositoryMounts } = prepareBuildProjectConfig(
      root,
      new ProjectConfigManager(
        {
          version: '1.2',
          languages: [],
          mcps: [],
          packageManagers: [],
          taskManagers: [],
          attribution: true,
          projects: [
            {
              name: 'frontend',
              path: 'frontend',
              repository: '/workspace/sources/frontend.git',
            },
          ],
        } as any,
        root
      )
    );

    expect(repositoryMounts).toEqual([]);
    expect(buildProjectConfig.projects?.[0]?.repository).toBe(
      '/workspace/sources/frontend.git'
    );
  });

  it('rewrites absolute host repository paths during build config preparation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    const hostRepo = mkdtempSync(join(tmpdir(), 'rover-build-host-repo-'));
    testDirs.push(root, hostRepo);

    const { buildProjectConfig, repositoryMounts } = prepareBuildProjectConfig(
      root,
      new ProjectConfigManager(
        {
          version: '1.2',
          languages: [],
          mcps: [],
          packageManagers: [],
          taskManagers: [],
          attribution: true,
          projects: [
            {
              name: 'frontend',
              path: 'frontend',
              repository: hostRepo,
            },
          ],
        } as any,
        root
      )
    );

    expect(repositoryMounts).toEqual([
      {
        hostPath: hostRepo,
        containerPath: '/workspace-repos/0',
      },
    ]);
    expect(buildProjectConfig.projects?.[0]?.repository).toBe(
      '/workspace-repos/0'
    );
  });

  it('excludes unsafe-path projects during build config preparation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-build-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const { buildProjectConfig, repositoryMounts } = prepareBuildProjectConfig(
      root,
      new ProjectConfigManager(
        {
          version: '1.2',
          languages: [],
          mcps: [],
          packageManagers: [],
          taskManagers: [],
          attribution: true,
          projects: [
            {
              name: 'unsafe',
              path: '../../escape',
              repository: './repos/missing.git',
            },
            {
              name: 'frontend',
              path: 'frontend',
              repository: './repos/frontend.git',
            },
          ],
        } as any,
        root
      )
    );

    // Unsafe project is filtered out entirely, only safe project remains
    expect(buildProjectConfig.projects).toHaveLength(1);
    expect(buildProjectConfig.projects?.[0]?.name).toBe('frontend');
    expect(buildProjectConfig.projects?.[0]?.repository).toBe(
      '/workspace-repos/1'
    );
    expect(repositoryMounts).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/1',
      },
    ]);
  });
});
