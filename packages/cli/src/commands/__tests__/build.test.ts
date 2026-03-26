import { describe, expect, it } from 'vitest';
import { generateBuildEntrypoint } from '../build.js';

describe('generateBuildEntrypoint', () => {
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
      'sudo rover-agent-install $AGENT || true'
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
});
