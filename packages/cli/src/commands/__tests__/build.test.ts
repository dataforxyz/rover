import { describe, expect, it } from 'vitest';
import { generateBuildEntrypoint } from '../build.js';

describe('generateBuildEntrypoint', () => {
  it('uses staged child repos and runs root plus project init scripts during cache builds', () => {
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
    expect(script).toContain(
      'Validating external repositories for cache build'
    );
    expect(script).toContain(
      "Missing child repository 'frontend' at '/workspace/frontend' in the staged build workspace"
    );
    expect(script).toContain(
      "Missing child repository 'backend' at '/workspace/backend' in the staged build workspace"
    );
    expect(script).toContain(
      'rover build does not clone child repositories from project.repository.'
    );
    expect(script).not.toContain('git clone');
    expect(script).not.toContain('git fetch');
    expect(script).toContain('bash "/workspace/scripts/system-init.sh"');
    expect(script).toContain('bash "/workspace/frontend/scripts/init.sh"');
    expect(script).toContain('bash "/workspace/backend/scripts/init.sh"');
  });
});
