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
    expect(script).toContain('bash "/workspace/scripts/system-init.sh"');
    expect(script).toContain('bash "/workspace/frontend/scripts/init.sh"');
    expect(script).toContain('bash "/workspace/backend/scripts/init.sh"');
  });
});
