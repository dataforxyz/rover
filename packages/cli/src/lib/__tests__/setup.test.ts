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
    expect(script).toContain('Checking out main for frontend');
    expect(script).toContain(
      "git -C '/workspace/frontend' checkout -B 'main' origin/'main'"
    );
    expect(script).toContain('Failed to fetch updates for frontend');
    expect(script).not.toContain(
      "git -C '/workspace/frontend' fetch --all --tags --prune || true"
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

  it('quotes sub-project paths when running init scripts', () => {
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
      allInitScripts: [{ script: 'scripts/init.sh', path: 'apps/web ui' }],
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

    expect(script).toContain('echo "🔎 Validating initialization scripts"');
    expect(script).toContain('echo "❌ Missing initialization scripts:"');
    expect(script).toContain(
      'checked: /init-script-0.sh, /workspace/apps/web ui/scripts/init.sh'
    );
    expect(script).toContain("cd '/workspace/apps/web ui'");
    expect(script).toContain('Failed to enter project path apps/web ui');
  });

  it('falls back to workspace init script path when mount is unavailable', () => {
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
        { script: 'scripts/bootstrap.sh', path: 'services/api' },
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

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain('echo "✅ Initialization scripts validated"');
    expect(script).toContain(
      "elif [ -f '/workspace/services/api/scripts/bootstrap.sh' ]; then"
    );
    expect(script).toContain(
      "chmod +x '/workspace/services/api/scripts/bootstrap.sh'"
    );
    expect(script).toContain(
      "/bin/sh '/workspace/services/api/scripts/bootstrap.sh'"
    );
  });

  it('escapes sub-project paths in init script log lines', () => {
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
        { script: 'scripts/init.sh', path: 'apps/$(touch pwn)' },
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

    const entrypointPath = builder.generateEntrypoint(false);
    const script = readFileSync(entrypointPath, 'utf8');

    expect(script).toContain("cd '/workspace/apps/$(touch pwn)'");
    expect(script).toContain(
      'echo "❌ Failed to enter project path apps/\\$(touch pwn)"'
    );
    expect(script).toContain(
      'echo "🔧 Running initialization script (apps/\\$(touch pwn))"'
    );
  });

  it('escapes repository metadata in sync log lines', () => {
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
          name: 'frontend $(touch pwn)',
          path: 'apps/$(touch pwn)',
          repository: 'https://github.com/dataforxyz/frontend.git',
          ref: 'main-$(touch pwn)',
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
      'echo "📥 Syncing repository frontend \\$(touch pwn)"'
    );
    expect(script).toContain(
      'echo "🔀 Checking out main-\\$(touch pwn) for frontend \\$(touch pwn)"'
    );
    expect(script).toContain(
      'echo "❌ Existing repository at /workspace/apps/\\$(touch pwn) points to a different origin"'
    );
    expect(script).toContain(
      'echo "✅ Repository frontend \\$(touch pwn) is ready"'
    );
  });
});
