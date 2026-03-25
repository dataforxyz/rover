/**
 * Shared dependency resolution command generation for build and setup entrypoints.
 *
 * Both `build.ts` (cache image builds) and `setup.ts` (task entrypoints) need to
 * generate shell commands that resolve workspace dependencies. This module provides
 * a single implementation to keep them in sync.
 */

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}' `;
}

interface DependencyLocation {
  path: string;
  packageManagers: string[];
  label: string;
}

interface ProjectEntry {
  path: string;
  packageManagers?: string[];
}

interface DependencyResolutionConfig {
  rootPackageManagers: string[];
  projects?: ProjectEntry[];
  /** Whether to add venv PATH exports for uv projects (used in setup, not build) */
  addVenvPathExports?: boolean;
}

export function getDependencyResolutionCommands(
  config: DependencyResolutionConfig
): string[] {
  const commands: string[] = [];
  const locations: DependencyLocation[] = [
    {
      path: '/workspace',
      packageManagers: config.rootPackageManagers,
      label: 'workspace root',
    },
    ...(config.projects ?? []).map(project => ({
      path: `/workspace/${project.path}`,
      packageManagers: project.packageManagers ?? [],
      label: project.path,
    })),
  ];

  for (const location of locations) {
    const quotedPath = shellEscape(location.path).trim();
    const pms = location.packageManagers;

    if (pms.includes('uv')) {
      commands.push(
        `if [ -f ${quotedPath}/pyproject.toml ]; then`,
        `  echo "📦 Resolving Python dependencies (uv) in ${location.label}..."`,
        `  cd ${quotedPath} && uv sync --frozen --all-extras 2>/dev/null || uv sync --all-extras 2>/dev/null || uv sync 2>/dev/null || true`
      );
      if (config.addVenvPathExports) {
        commands.push(
          `  if [ -d ${quotedPath}/.venv/bin ]; then`,
          `    export PATH="${location.path}/.venv/bin:$PATH"`,
          `    echo 'export PATH="${location.path}/.venv/bin:$PATH"' >> $HOME/.profile`,
          '  fi'
        );
      }
      commands.push('fi');
    }

    if (pms.includes('poetry')) {
      commands.push(
        `if [ -f ${quotedPath}/pyproject.toml ]; then`,
        `  echo "📦 Resolving Python dependencies (poetry) in ${location.label}..."`,
        `  cd ${quotedPath} && poetry install --no-interaction 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('pub')) {
      commands.push(
        `if [ -f ${quotedPath}/pubspec.yaml ]; then`,
        `  echo "📦 Resolving Dart dependencies in ${location.label}..."`,
        `  cd ${quotedPath} && flutter pub get 2>/dev/null || dart pub get 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('npm')) {
      commands.push(
        `if [ -f ${quotedPath}/package-lock.json ]; then`,
        `  echo "📦 Resolving Node.js dependencies (npm) in ${location.label}..."`,
        `  cd ${quotedPath} && npm ci 2>/dev/null || npm install 2>/dev/null || true`,
        `elif [ -f ${quotedPath}/package.json ]; then`,
        `  echo "📦 Resolving Node.js dependencies (npm) in ${location.label}..."`,
        `  cd ${quotedPath} && npm install 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('pnpm')) {
      commands.push(
        `if [ -f ${quotedPath}/pnpm-lock.yaml ]; then`,
        `  echo "📦 Resolving Node.js dependencies (pnpm) in ${location.label}..."`,
        `  cd ${quotedPath} && pnpm install --frozen-lockfile 2>/dev/null || pnpm install 2>/dev/null || true`,
        `elif [ -f ${quotedPath}/package.json ]; then`,
        `  echo "📦 Resolving Node.js dependencies (pnpm) in ${location.label}..."`,
        `  cd ${quotedPath} && pnpm install 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('yarn')) {
      commands.push(
        `if [ -f ${quotedPath}/yarn.lock ]; then`,
        `  echo "📦 Resolving Node.js dependencies (yarn) in ${location.label}..."`,
        `  cd ${quotedPath} && yarn install --frozen-lockfile 2>/dev/null || yarn install 2>/dev/null || true`,
        `elif [ -f ${quotedPath}/package.json ]; then`,
        `  echo "📦 Resolving Node.js dependencies (yarn) in ${location.label}..."`,
        `  cd ${quotedPath} && yarn install 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('composer')) {
      commands.push(
        `if [ -f ${quotedPath}/composer.json ]; then`,
        `  echo "📦 Resolving PHP dependencies in ${location.label}..."`,
        `  cd ${quotedPath} && composer install --no-interaction 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('cargo')) {
      commands.push(
        `if [ -f ${quotedPath}/Cargo.toml ]; then`,
        `  echo "📦 Resolving Rust dependencies in ${location.label}..."`,
        `  cd ${quotedPath} && cargo fetch 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('gomod')) {
      commands.push(
        `if [ -f ${quotedPath}/go.mod ]; then`,
        `  echo "📦 Resolving Go dependencies in ${location.label}..."`,
        `  cd ${quotedPath} && go mod download 2>/dev/null || true`
      );
      // setup.ts also checks src/go.mod; build.ts does not — keep the superset
      commands.push(
        `elif [ -f ${quotedPath}/src/go.mod ]; then`,
        `  cd ${quotedPath}/src && go mod download 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('pip')) {
      commands.push(
        `if [ -f ${quotedPath}/requirements.txt ]; then`,
        `  echo "📦 Resolving Python dependencies (pip) in ${location.label}..."`,
        `  cd ${quotedPath} && pip install -r requirements.txt 2>/dev/null || true`,
        'fi'
      );
    }

    if (pms.includes('rubygems')) {
      commands.push(
        `if [ -f ${quotedPath}/Gemfile ]; then`,
        `  echo "📦 Resolving Ruby dependencies in ${location.label}..."`,
        `  cd ${quotedPath} && bundle install 2>/dev/null || true`,
        'fi'
      );
    }
  }

  if (commands.length > 0) {
    commands.push('cd /workspace');
  }

  return commands;
}
