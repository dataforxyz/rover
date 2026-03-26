import type { ProjectConfigManager } from 'rover-core';
import { isSafeRelativePath } from '../../utils/path-safety.js';

// Language packages
import { JavaScriptSandboxPackage } from './languages/javascript.js';
import { TypeScriptSandboxPackage } from './languages/typescript.js';
import { PHPSandboxPackage } from './languages/php.js';
import { RustSandboxPackage } from './languages/rust.js';
import { GoSandboxPackage } from './languages/go.js';
import { PythonSandboxPackage } from './languages/python.js';
import { RubySandboxPackage } from './languages/ruby.js';
import { DartSandboxPackage } from './languages/dart.js';

// Package manager packages
import { NpmSandboxPackage } from './package-managers/npm.js';
import { PnpmSandboxPackage } from './package-managers/pnpm.js';
import { YarnSandboxPackage } from './package-managers/yarn.js';
import { ComposerSandboxPackage } from './package-managers/composer.js';
import { CargoSandboxPackage } from './package-managers/cargo.js';
import { GomodSandboxPackage } from './package-managers/gomod.js';
import { PipSandboxPackage } from './package-managers/pip.js';
import { PoetrySandboxPackage } from './package-managers/poetry.js';
import { UvSandboxPackage } from './package-managers/uv.js';
import { RubygemsSandboxPackage } from './package-managers/rubygems.js';
import { PubSandboxPackage } from './package-managers/pub.js';

// Task manager packages
import { JustSandboxPackage } from './task-managers/just.js';
import { MakeSandboxPackage } from './task-managers/make.js';
import { TaskSandboxPackage } from './task-managers/task.js';

import type { SandboxPackage } from './types.js';

const langMap: Record<
  string,
  (options: { workspaceProjectPaths: string[] }) => SandboxPackage
> = {
  javascript: () => new JavaScriptSandboxPackage(),
  typescript: () => new TypeScriptSandboxPackage(),
  php: () => new PHPSandboxPackage(),
  rust: () => new RustSandboxPackage(),
  go: options => new GoSandboxPackage(options.workspaceProjectPaths),
  python: () => new PythonSandboxPackage(),
  ruby: () => new RubySandboxPackage(),
  dart: options => new DartSandboxPackage(options.workspaceProjectPaths),
};

const pmMap: Record<string, () => SandboxPackage> = {
  npm: () => new NpmSandboxPackage(),
  pnpm: () => new PnpmSandboxPackage(),
  yarn: () => new YarnSandboxPackage(),
  composer: () => new ComposerSandboxPackage(),
  cargo: () => new CargoSandboxPackage(),
  gomod: () => new GomodSandboxPackage(),
  pip: () => new PipSandboxPackage(),
  poetry: () => new PoetrySandboxPackage(),
  uv: () => new UvSandboxPackage(),
  rubygems: () => new RubygemsSandboxPackage(),
  pub: () => new PubSandboxPackage(),
};

const tmMap: Record<string, () => SandboxPackage> = {
  just: () => new JustSandboxPackage(),
  make: () => new MakeSandboxPackage(),
  task: () => new TaskSandboxPackage(),
};

/**
 * Instantiate SandboxPackage objects for all languages, package managers,
 * and task managers declared in the project configuration (including
 * sub-project entries).
 */
export function getPackagesFromConfig(
  projectConfig: ProjectConfigManager
): SandboxPackage[] {
  const packages: SandboxPackage[] = [];
  const workspaceProjectPaths = (projectConfig.projects ?? []).flatMap(
    project =>
      typeof project?.path === 'string' && isSafeRelativePath(project.path)
        ? [project.path]
        : []
  );

  for (const lang of projectConfig.allLanguages ?? []) {
    if (langMap[lang]) packages.push(langMap[lang]({ workspaceProjectPaths }));
  }
  for (const pm of projectConfig.allPackageManagers ?? []) {
    if (pmMap[pm]) packages.push(pmMap[pm]());
  }
  for (const tm of projectConfig.allTaskManagers ?? []) {
    if (tmMap[tm]) packages.push(tmMap[tm]());
  }

  return packages;
}
