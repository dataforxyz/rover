import { describe, expect, it } from 'vitest';
import { getDependencyResolutionCommands } from '../dependency-resolution.js';

describe('getDependencyResolutionCommands', () => {
  it('returns empty array for no package managers', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: [],
    });
    expect(result).toEqual([]);
  });

  it('generates npm commands for root workspace', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['npm'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('npm ci');
    expect(joined).toContain("'/workspace'");
    expect(joined).toContain('cd /workspace');
  });

  it('generates pnpm commands with lockfile check', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['pnpm'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('pnpm install --frozen-lockfile');
    expect(joined).toContain('pnpm-lock.yaml');
  });

  it('generates yarn commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['yarn'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('yarn install --frozen-lockfile');
    expect(joined).toContain('yarn.lock');
  });

  it('generates uv commands without venv exports by default', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['uv'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('uv sync');
    expect(joined).toContain('pyproject.toml');
    expect(joined).not.toContain('.venv/bin');
  });

  it('generates uv commands with venv PATH exports when requested', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['uv'],
      addVenvPathExports: true,
    });
    const joined = result.join('\n');
    expect(joined).toContain('.venv/bin');
    expect(joined).toContain('$HOME/.profile');
  });

  it('does not export subproject uv environments onto the global PATH', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: [],
      projects: [
        { path: 'api', packageManagers: ['uv'] },
        { path: 'worker', packageManagers: ['uv'] },
      ],
      addVenvPathExports: true,
    });
    const joined = result.join('\n');

    expect(joined).toContain("cd '/workspace/api' && uv sync");
    expect(joined).toContain("cd '/workspace/worker' && uv sync");
    expect(joined).not.toContain('/workspace/api/.venv/bin:$PATH');
    expect(joined).not.toContain('/workspace/worker/.venv/bin:$PATH');
    expect(joined).not.toContain('$HOME/.profile');
  });

  it('generates poetry commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['poetry'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('poetry install');
    expect(joined).toContain('pyproject.toml');
  });

  it('generates pub commands for Dart', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['pub'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('flutter pub get');
    expect(joined).toContain('dart pub get');
    expect(joined).toContain('pubspec.yaml');
  });

  it('generates gomod commands with src/go.mod fallback', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['gomod'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('go mod download');
    expect(joined).toContain('go.mod');
    expect(joined).toContain('src/go.mod');
  });

  it('generates composer commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['composer'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('composer install');
    expect(joined).toContain('composer.json');
  });

  it('generates cargo commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['cargo'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('cargo fetch');
    expect(joined).toContain('Cargo.toml');
  });

  it('generates pip commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['pip'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('pip install -r requirements.txt');
  });

  it('generates rubygems commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['rubygems'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('bundle install');
    expect(joined).toContain('Gemfile');
  });

  it('generates commands for multiple package managers', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['npm', 'pip'],
    });
    const joined = result.join('\n');
    expect(joined).toContain('npm');
    expect(joined).toContain('pip install');
  });

  it('generates commands for project subpaths', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: [],
      projects: [
        { path: 'frontend', packageManagers: ['pub'] },
        { path: 'backend', packageManagers: ['gomod'] },
      ],
    });
    const joined = result.join('\n');
    expect(joined).toContain("'/workspace/frontend'");
    expect(joined).toContain("'/workspace/backend'");
    expect(joined).toContain('flutter pub get');
    expect(joined).toContain('go mod download');
  });

  it('generates commands for both root and project locations', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['npm'],
      projects: [{ path: 'e2e', packageManagers: ['pip'] }],
    });
    const joined = result.join('\n');
    // Root npm
    expect(joined).toContain("'/workspace'/package-lock.json");
    // Project pip
    expect(joined).toContain("'/workspace/e2e'/requirements.txt");
  });

  it('skips projects with no package managers', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: [],
      projects: [{ path: 'empty', packageManagers: [] }],
    });
    expect(result).toEqual([]);
  });

  it('appends cd /workspace at end when commands are generated', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: ['npm'],
    });
    expect(result[result.length - 1]).toBe('cd /workspace');
  });

  it('does not produce shell-unsafe output for paths with single quotes', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: [],
      projects: [{ path: "it's-a-test", packageManagers: ['npm'] }],
    });
    const joined = result.join('\n');
    // Should contain properly escaped path, not bare single quote
    expect(joined).not.toContain("'/workspace/it's-a-test'");
    expect(joined).toContain('it');
    expect(joined).toContain('npm');
  });

  it('filters unsafe project paths before generating dependency commands', () => {
    const result = getDependencyResolutionCommands({
      rootPackageManagers: [],
      projects: [
        { path: '../../escape', packageManagers: ['npm'] },
        { path: '/absolute', packageManagers: ['pip'] },
        { path: 'frontend', packageManagers: ['pnpm'] },
      ],
    });
    const joined = result.join('\n');

    expect(joined).toContain("'/workspace/frontend'");
    expect(joined).not.toContain('/workspace/../../escape');
    expect(joined).not.toContain('/workspace//absolute');
  });
});
