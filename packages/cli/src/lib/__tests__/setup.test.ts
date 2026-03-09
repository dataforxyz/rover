import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('hard resets and cleans reused external repositories before checkout', () => {
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
    expect(script).toContain("git -C '/workspace/frontend' clean -fd");
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
    expect(script).toContain("cd '/workspace/frontend'");
    expect(script).toContain('/bin/sh /init-script-1.sh');
    expect(script).not.toContain('/bin/sh /init-script-0.sh');
    expect(script).not.toContain('echo "🔧 Running initialization script"\n');
  });
});
