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
});
