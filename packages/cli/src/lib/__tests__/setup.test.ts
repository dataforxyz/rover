import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupBuilder } from '../setup.js';

vi.mock('rover-core', async () => {
  const actual =
    await vi.importActual<typeof import('rover-core')>('rover-core');
  return {
    ...actual,
    launchSync: vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'docker') {
        return {
          stdout: JSON.stringify({ SecurityOptions: [] }),
        };
      }
      return { stdout: '' };
    }),
  };
});

describe('SetupBuilder multi-repo projects', () => {
  const testDirs: string[] = [];

  afterEach(() => {
    for (const dir of testDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  it('generates repository sync commands for project list entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          ref: 'main',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('Syncing external repositories');
    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/frontend.git' '/workspace/frontend'"
    );
    expect(script).toContain("Checking out 'main' for 'frontend'");
    expect(script).toContain(
      "git -C '/workspace/frontend' checkout -B 'main' refs/remotes/origin/'main'"
    );
    expect(script).toContain(
      "git -C '/workspace/frontend' checkout --detach 'main'"
    );
    expect(script).toContain(
      "git -C '/workspace/frontend' checkout -B 'task/1' HEAD"
    );
  });

  it('installs the agent CLI without unsupported install flags', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('sudo -E rover-agent install $AGENT');
    expect(script).not.toContain('--user-dir');
  });

  it('syncs repositories without an explicit ref to the remote default branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'backend',
          path: 'backend',
          repository: 'https://github.com/dataforxyz/backend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain(
      "default_remote_ref=$(git -C '/workspace/backend' symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    );
    expect(script).toContain(
      `git -C '/workspace/backend' checkout -B "$default_branch" "$default_remote_ref"`
    );
  });

  it('runs repository sync before package install, init scripts, and dependency resolution in the runtime entrypoint template', () => {
    const script = readFileSync(
      new URL('../entrypoint.sh', import.meta.url),
      'utf8'
    );

    const repoSyncIndex = script.indexOf('{projectRepositoriesSection}');
    const packageInstallIndex = script.indexOf('{installAllPackages}');
    const initScriptIndex = script.indexOf('{initScriptExecution}');
    const dependencyResolutionIndex = script.indexOf('{workspaceDeps}');
    const sudoersRemovalIndex = script.indexOf('{sudoersRemoval}');

    expect(repoSyncIndex).toBeGreaterThanOrEqual(0);
    expect(packageInstallIndex).toBeGreaterThan(repoSyncIndex);
    expect(initScriptIndex).toBeGreaterThan(packageInstallIndex);
    expect(dependencyResolutionIndex).toBeGreaterThan(initScriptIndex);
    expect(sudoersRemovalIndex).toBeGreaterThan(initScriptIndex);
  });

  it('resolves project dependencies on non-cached startup after syncing repositories', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      packageManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['npm'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    const repoSyncIndex = script.indexOf('Syncing external repositories');
    const dependencyResolutionIndex = script.indexOf(
      "cd '/workspace/frontend' && npm install 2>/dev/null || true"
    );

    expect(repoSyncIndex).toBeGreaterThanOrEqual(0);
    expect(dependencyResolutionIndex).toBeGreaterThan(repoSyncIndex);
  });

  it('runs init scripts before dependency resolution and sudo removal on non-cached startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      packageManagers: ['uv'],
      mcps: [],
      initScript: 'scripts/root-init.sh',
      allInitScripts: [{ script: 'scripts/root-init.sh' }],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    const initScriptIndex = script.indexOf('bash "$root_script_0"');
    const dependencyResolutionIndex = script.indexOf(
      "cd '/workspace' && uv sync"
    );
    const sudoersRemovalIndex = script.indexOf(
      'sudo rm -f /etc/sudoers.d/1-agent-setup'
    );

    expect(initScriptIndex).toBeGreaterThanOrEqual(0);
    expect(dependencyResolutionIndex).toBeGreaterThan(initScriptIndex);
    expect(sudoersRemovalIndex).toBeGreaterThan(initScriptIndex);
  });

  it('runs root init scripts from mounted host paths when they live outside /workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: '../shared/root-init.sh',
      allInitScripts: [{ script: '../shared/root-init.sh' }],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain("mounted_script_0='/init-script.sh'");
    expect(script).toContain(
      "workspace_script_0='/workspace/../shared/root-init.sh'"
    );
    expect(script).toContain('if [ -f "$mounted_script_0" ]; then');
    expect(script).toContain('bash "$root_script_0"');
  });

  it('syncs repositories before installing languages on non-cached startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: ['go'],
      allPackageManagers: [],
      allTaskManagers: [],
      packageManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'backend',
          path: 'backend',
          repository: 'https://github.com/dataforxyz/backend.git',
          languages: ['go'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    const repoSyncIndex = script.indexOf('Syncing external repositories');
    const installGoIndex = script.indexOf('📦 Installing go...');
    const goVersionProbeIndex = script.indexOf(
      "for go_mod_path in '/workspace/go.mod' '/workspace/src/go.mod' '/workspace/backend/go.mod' '/workspace/backend/src/go.mod'; do"
    );

    expect(repoSyncIndex).toBeGreaterThanOrEqual(0);
    expect(installGoIndex).toBeGreaterThan(repoSyncIndex);
    expect(goVersionProbeIndex).toBeGreaterThan(repoSyncIndex);
  });

  it('includes repository metadata in workspace description', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'e2e',
          path: 'e2e',
          repository: 'https://github.com/dataforxyz/e2e.git',
          ref: 'develop',
          languages: ['python'],
          packageManagers: ['pip'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );
    const descPath = builder.generateWorkspaceDescription();
    expect(descPath).toBeDefined();

    const description = JSON.parse(readFileSync(descPath!, 'utf8'));
    expect(description.projects[0]).toMatchObject({
      name: 'e2e',
      path: 'e2e',
      repository: 'https://github.com/dataforxyz/e2e.git',
      ref: 'develop',
      languages: ['python'],
      packageManagers: ['pip'],
    });
  });

  it('mounts local child repositories and clones them via container-visible paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: './repos/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(builder.getRepositoryMounts()).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/0',
      },
    ]);
    expect(script).toContain(
      "git clone '/workspace-repos/0' '/workspace/frontend'"
    );
  });

  it('preserves original local child repository values in workspace description', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: './repos/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(description.projects[0]).toMatchObject({
      name: 'frontend',
      path: 'frontend',
      repository: './repos/frontend.git',
    });
  });

  it('does not treat absolute container repository paths as host mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: '/workspace/sources/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(builder.getRepositoryMounts()).toEqual([]);
    expect(script).toContain(
      "git clone '/workspace/sources/frontend.git' '/workspace/frontend'"
    );
  });

  it('treats absolute host repository paths as host mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    const hostRepo = mkdtempSync(join(tmpdir(), 'rover-setup-host-repo-'));
    testDirs.push(root, hostRepo);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: hostRepo,
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(builder.getRepositoryMounts()).toEqual([
      {
        hostPath: hostRepo,
        containerPath: '/workspace-repos/0',
      },
    ]);
    expect(script).toContain(
      "git clone '/workspace-repos/0' '/workspace/frontend'"
    );
  });

  it('validates external repository state during checkpoint resume', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          ref: 'main',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any,
      { resumeFromCheckpoint: true }
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain(
      'Verifying external repositories for checkpoint resume'
    );
    expect(script).toContain(
      "Repository 'frontend' is missing at '/workspace/frontend'; cannot resume from checkpoint safely"
    );
    expect(script).toContain('Checkpoint is missing repository state for');
    expect(script).toContain(
      "current_head=$(git -C '/workspace/frontend' rev-parse HEAD)"
    );
    expect(script).toContain(
      "Repository 'frontend' no longer matches the checkpointed revision"
    );
    expect(script).toContain("createHash('sha256')");
    expect(script).toContain('readFileSync(fullPath)');
    expect(script).toContain(".trimEnd()).digest('hex')");
    expect(script).not.toContain('sha256sum "$repo_path/$relative_path"');
    expect(script).not.toContain(
      "git clone 'https://github.com/dataforxyz/frontend.git' '/workspace/frontend'"
    );
  });

  it('escapes quoted project paths in checkpoint resume verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: "apps/it's-api",
          repository: 'https://github.com/dataforxyz/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any,
      { resumeFromCheckpoint: true }
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain("node -e 'const fs=require(");
    expect(script).toContain(`repo.path === "apps/it'"'"'s-api"`);
  });

  it('hard resets and fully cleans reused external repositories before checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          ref: 'main',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain("git -C '/workspace/frontend' reset --hard HEAD");
    expect(script).toContain("git -C '/workspace/frontend' clean -fdx");
    expect(script).toContain(
      "if ! git -C '/workspace/frontend' fetch --all --tags --prune; then"
    );
    expect(script).toContain("❌ Failed to fetch repository 'frontend'");
    expect(script).not.toContain(
      "git -C '/workspace/frontend' fetch --all --tags --prune || true"
    );
  });

  it('keeps init-script mount indices aligned on cached image reuse', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: 'scripts/root-init.sh',
      allInitScripts: [
        { script: 'scripts/root-init.sh' },
        { script: 'scripts/frontend-init.sh', path: 'frontend' },
      ],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          initScript: 'scripts/frontend-init.sh',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('🔧 Running initialization scripts');
    expect(script).toContain('🔧 Running initialization script (frontend)');
    expect(script).toContain(
      "workspace_project_script_1='/workspace/frontend/scripts/frontend-init.sh'"
    );
    expect(script).toContain("workspace_dir_1='/workspace/frontend'");
    expect(script).toContain('if [ -f "$workspace_project_script_1" ]; then');
    expect(script).toContain(
      'echo "❌ Initialization script (frontend) not found at $workspace_project_script_1 or $workspace_root_script_1"'
    );
    expect(script).toContain('bash "$workspace_script_1"');
    expect(script).not.toContain('/bin/sh /init-script-0.sh');
    expect(script).not.toContain(
      "\n'/workspace/frontend/scripts/frontend-init.sh'\n"
    );
    expect(script).not.toContain("\n'/workspace/scripts/root-init.sh'\n");
    expect(script).not.toContain("/bin/sh '/workspace/scripts/root-init.sh'");
    expect(script).toContain(
      "workspace_root_script_1='/workspace/scripts/frontend-init.sh'"
    );
  });

  it('falls back to root init scripts for project-scoped entries during cached startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [
        { script: 'scripts/frontend-init.sh', path: 'frontend' },
      ],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain(
      "workspace_project_script_0='/workspace/frontend/scripts/frontend-init.sh'"
    );
    expect(script).toContain(
      "workspace_root_script_0='/workspace/scripts/frontend-init.sh'"
    );
    expect(script).toContain('elif [ -f "$workspace_root_script_0" ]; then');
    expect(script).toContain("workspace_dir_0='/workspace'");
  });

  it('filters unsafe project-scoped init-script paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [
        { script: 'scripts/root-init.sh' },
        { script: 'scripts/bad.sh', path: '../../escape' },
        { script: 'scripts/frontend-init.sh', path: 'frontend' },
      ],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('/workspace/frontend/scripts/frontend-init.sh');
    expect(script).not.toContain('/workspace/../../escape');
    expect(script).not.toContain('scripts/bad.sh');
  });

  it('filters project-scoped init scripts whose path escapes through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'rover-setup-outside-'));
    testDirs.push(root);
    testDirs.push(outside);
    symlinkSync(outside, join(root, 'services'));

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [{ script: 'scripts/init.sh', path: 'services/api' }],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).not.toContain('/workspace/services/api/scripts/init.sh');
  });

  it('resolves dependencies for configured sub-project package managers', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: ['pub', 'gomod', 'uv'],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['pub'],
        },
        {
          name: 'backend',
          path: 'backend',
          repository: 'https://github.com/dataforxyz/backend.git',
          packageManagers: ['gomod'],
        },
        {
          name: 'e2e',
          path: 'e2e',
          repository: 'https://github.com/dataforxyz/e2e.git',
          packageManagers: ['uv'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('Resolving Dart dependencies in frontend');
    expect(script).toContain(
      "cd '/workspace/frontend' && flutter pub get 2>/dev/null || dart pub get 2>/dev/null || true"
    );
    expect(script).toContain('Resolving Go dependencies in backend');
    expect(script).toContain(
      "cd '/workspace/backend' && go mod download 2>/dev/null || true"
    );
    expect(script).toContain('Resolving Python dependencies (uv) in e2e');
    expect(script).toContain(
      "cd '/workspace/e2e' && uv sync --frozen --all-extras 2>/dev/null || uv sync --all-extras 2>/dev/null || uv sync 2>/dev/null || true"
    );
    expect(script).toContain('export PATH="/workspace/e2e/.venv/bin:$PATH"');
    expect(script).toContain(
      `echo 'export PATH="/workspace/e2e/.venv/bin:$PATH"' >> $HOME/.profile`
    );
  });

  it('prefers persisted workspace projects over the current config for existing tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const iterationOnePath = join(root, 'iterations', '1');
    mkdirSync(iterationOnePath, { recursive: true });
    writeFileSync(
      join(iterationOnePath, 'workspace-description.json'),
      JSON.stringify({
        projects: [
          {
            name: 'frontend',
            path: 'frontend',
            repository: 'https://github.com/dataforxyz/frontend.git',
            ref: 'release/1.0',
            languages: ['python'],
            packageManagers: ['uv'],
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      languages: ['typescript'],
      packageManagers: ['pnpm'],
      allLanguages: ['typescript'],
      allPackageManagers: ['pnpm'],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'backend',
          path: 'backend',
          repository: 'https://github.com/dataforxyz/backend.git',
          packageManagers: ['npm'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/frontend.git' '/workspace/frontend'"
    );
    expect(script).toContain("Checking out 'release/1.0' for 'frontend'");
    expect(script).not.toContain('/workspace/backend');
    expect(script).toContain('Resolving Python dependencies (uv) in frontend');
    expect(script).not.toContain(
      'Resolving Node.js dependencies (npm) in backend'
    );
    expect(description.projects).toEqual([
      expect.objectContaining({
        name: 'frontend',
        path: 'frontend',
        repository: 'https://github.com/dataforxyz/frontend.git',
        ref: 'release/1.0',
        languages: ['python'],
        packageManagers: ['uv'],
      }),
    ]);
  });

  it('preserves a root-only workspace when persisted metadata has no projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const iterationOnePath = join(root, 'iterations', '1');
    mkdirSync(iterationOnePath, { recursive: true });
    writeFileSync(
      join(iterationOnePath, 'workspace-description.json'),
      JSON.stringify({ projects: [] })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['pnpm'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();

    expect(script).not.toContain('/workspace/frontend');
    expect(descPath).toBeUndefined();
  });

  it('falls back to the current config when older iterations have no persisted metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    mkdirSync(join(root, 'iterations', '1'), { recursive: true });

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['pnpm'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/frontend.git' '/workspace/frontend'"
    );
    expect(description.projects).toEqual([
      expect.objectContaining({
        name: 'frontend',
        path: 'frontend',
        repository: 'https://github.com/dataforxyz/frontend.git',
        packageManagers: ['pnpm'],
      }),
    ]);
  });

  it('falls back to legacy worktree metadata when iteration metadata is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    const worktreePath = join(root, 'workspace');
    mkdirSync(worktreePath, { recursive: true });

    writeFileSync(
      join(worktreePath, '.rover-workspace.json'),
      JSON.stringify({
        projects: [
          {
            name: 'legacy',
            path: 'legacy',
            repository: 'https://github.com/dataforxyz/legacy.git',
            packageManagers: ['uv'],
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      worktreePath,
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['pnpm'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/legacy.git' '/workspace/legacy'"
    );
    expect(script).not.toContain('/workspace/frontend');
    expect(description.projects).toEqual([
      expect.objectContaining({
        name: 'legacy',
        path: 'legacy',
        repository: 'https://github.com/dataforxyz/legacy.git',
        packageManagers: ['uv'],
      }),
    ]);
  });

  it('falls back to legacy worktree metadata when iterations directory exists but is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    const worktreePath = join(root, 'workspace');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(root, 'iterations'), { recursive: true });

    writeFileSync(
      join(worktreePath, '.rover-workspace.json'),
      JSON.stringify({
        projects: [
          {
            name: 'legacy',
            path: 'legacy',
            repository: 'https://github.com/dataforxyz/legacy.git',
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      worktreePath,
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/legacy.git' '/workspace/legacy'"
    );
    expect(script).not.toContain('/workspace/frontend');
    expect(description.projects).toEqual([
      expect.objectContaining({
        name: 'legacy',
        path: 'legacy',
        repository: 'https://github.com/dataforxyz/legacy.git',
      }),
    ]);
  });

  it('falls back to legacy worktree metadata when newer iteration metadata is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    const worktreePath = join(root, 'workspace');
    mkdirSync(worktreePath, { recursive: true });

    mkdirSync(join(root, 'iterations', '1'), { recursive: true });
    writeFileSync(
      join(root, 'iterations', '1', 'workspace-description.json'),
      'not json {{{'
    );
    writeFileSync(
      join(worktreePath, '.rover-workspace.json'),
      JSON.stringify({
        projects: [
          {
            name: 'legacy',
            path: 'legacy',
            repository: 'https://github.com/dataforxyz/legacy.git',
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      worktreePath,
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain(
      "git clone 'https://github.com/dataforxyz/legacy.git' '/workspace/legacy'"
    );
    expect(script).not.toContain('/workspace/frontend');
  });

  it('does not infer the current config when persisted metadata is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const iterationOnePath = join(root, 'iterations', '1');
    mkdirSync(iterationOnePath, { recursive: true });
    writeFileSync(
      join(iterationOnePath, 'workspace-description.json'),
      'not json {{{'
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      packageManagers: [],
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'frontend',
          path: 'frontend',
          repository: 'https://github.com/dataforxyz/frontend.git',
          packageManagers: ['pnpm'],
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();

    expect(script).not.toContain('/workspace/frontend');
    expect(descPath).toBeUndefined();
  });

  it('filters unsafe workspace project paths from persisted metadata and config', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);

    const iterationOnePath = join(root, 'iterations', '1');
    mkdirSync(iterationOnePath, { recursive: true });
    writeFileSync(
      join(iterationOnePath, 'workspace-description.json'),
      JSON.stringify({
        projects: [
          {
            name: 'unsafe',
            path: '../../outside',
            repository: 'https://github.com/dataforxyz/unsafe.git',
          },
          {
            name: 'safe',
            path: 'frontend',
            repository: 'https://github.com/dataforxyz/frontend.git',
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      branchName: 'task/1',
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'also-unsafe',
          path: '/absolute',
          repository: 'https://github.com/dataforxyz/absolute.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const entrypointPath = builder.generateEntrypoint(
      true,
      'entrypoint.sh',
      true
    );
    const script = readFileSync(entrypointPath, 'utf8');
    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(script).toContain('/workspace/frontend');
    expect(script).not.toContain('../../outside');
    expect(script).not.toContain('/workspace/../../outside');
    expect(script).not.toContain('/workspace//absolute');
    expect(description.projects).toEqual([
      expect.objectContaining({
        name: 'safe',
        path: 'frontend',
      }),
    ]);
  });

  it('ignores unsafe configured local repositories before resolving mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'unsafe',
          path: '../../escape',
          repository: './repos/missing.git',
        },
        {
          name: 'safe',
          path: 'frontend',
          repository: './repos/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    expect(builder.getRepositoryMounts()).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/1',
      },
    ]);
  });

  it('ignores configured projects whose path escapes through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'rover-setup-outside-'));
    testDirs.push(root);
    testDirs.push(outside);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });
    symlinkSync(outside, join(root, 'services'));

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '1'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [
        {
          name: 'escaped',
          path: 'services/api',
          repository: './repos/missing.git',
        },
        {
          name: 'safe',
          path: 'frontend',
          repository: './repos/frontend.git',
        },
      ],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(builder.getRepositoryMounts()).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/1',
      },
    ]);
    expect(description.projects).toEqual([
      expect.objectContaining({ name: 'safe', path: 'frontend' }),
    ]);
  });

  it('ignores unsafe persisted local repositories before resolving mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    testDirs.push(root);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });

    const iterationOnePath = join(root, 'iterations', '1');
    mkdirSync(iterationOnePath, { recursive: true });
    writeFileSync(
      join(iterationOnePath, 'workspace-description.json'),
      JSON.stringify({
        projects: [
          {
            name: 'unsafe',
            path: '../../escape',
            repository: './repos/missing.git',
          },
          {
            name: 'safe',
            path: 'frontend',
            repository: './repos/frontend.git',
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    expect(builder.getRepositoryMounts()).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/1',
      },
    ]);
  });

  it('ignores persisted projects whose path escapes through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-setup-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'rover-setup-outside-'));
    testDirs.push(root);
    testDirs.push(outside);
    mkdirSync(join(root, 'repos', 'frontend.git'), { recursive: true });
    symlinkSync(outside, join(root, 'services'));

    const iterationOnePath = join(root, 'iterations', '1');
    mkdirSync(iterationOnePath, { recursive: true });
    writeFileSync(
      join(iterationOnePath, 'workspace-description.json'),
      JSON.stringify({
        projects: [
          {
            name: 'escaped',
            path: 'services/api',
            repository: './repos/missing.git',
          },
          {
            name: 'safe',
            path: 'frontend',
            repository: './repos/frontend.git',
          },
        ],
      })
    );

    const fakeTask = {
      id: 1,
      title: 'test',
      description: 'test',
      inputs: {},
      networkConfig: undefined,
      getBasePath: () => root,
      getIterationPath: () => join(root, 'iterations', '2'),
    };

    const fakeConfig = {
      allLanguages: [],
      allPackageManagers: [],
      allTaskManagers: [],
      mcps: [],
      initScript: undefined,
      allInitScripts: [],
      network: undefined,
      projectRoot: root,
      projects: [],
    };

    const builder = new SetupBuilder(
      fakeTask as any,
      'claude',
      fakeConfig as any
    );

    const descPath = builder.generateWorkspaceDescription();
    const description = JSON.parse(readFileSync(descPath!, 'utf8'));

    expect(builder.getRepositoryMounts()).toEqual([
      {
        hostPath: join(root, 'repos', 'frontend.git'),
        containerPath: '/workspace-repos/1',
      },
    ]);
    expect(description.projects).toEqual([
      expect.objectContaining({ name: 'safe', path: 'frontend' }),
    ]);
  });
});
