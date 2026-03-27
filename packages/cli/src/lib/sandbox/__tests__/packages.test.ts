import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectConfigManager } from 'rover-core';
import { getPackagesFromConfig } from '../packages.js';

function createProjectConfig(
  projectRoot: string,
  projects: Array<{ path: string }>
): ProjectConfigManager {
  return {
    version: '1.2',
    projectRoot,
    language: 'go',
    languages: ['go', 'dart'],
    packageManagers: [],
    taskManagers: [],
    allLanguages: ['go', 'dart'],
    allPackageManagers: [],
    allTaskManagers: [],
    projects,
    mcps: [],
    attribution: true,
    allInitScripts: [],
  } as unknown as ProjectConfigManager;
}

describe('getPackagesFromConfig', () => {
  it('ignores subproject paths that escape the workspace through symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'rover-packages-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'rover-packages-outside-'));

    try {
      mkdirSync(join(outside, 'api'), { recursive: true });
      symlinkSync(outside, join(root, 'services'));

      const packages = getPackagesFromConfig(
        createProjectConfig(root, [{ path: 'services/api' }])
      );

      const goScript =
        packages.find(pkg => pkg.name === 'Go')?.installScript() ?? '';
      const dartScript =
        packages.find(pkg => pkg.name === 'Dart')?.installScript() ?? '';

      expect(goScript).not.toContain('/workspace/services/api/go.mod');
      expect(goScript).not.toContain('/workspace/services/api/src/go.mod');
      expect(dartScript).not.toContain('/workspace/services/api/.fvmrc');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
