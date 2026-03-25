import colors from 'ansi-colors';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import {
  ProjectConfigManager,
  showProperties,
  showTitle,
  launch,
} from 'rover-core';
import { getProjectPath, isJsonMode } from '../lib/context.js';
import { getAvailableSandboxBackend } from '../lib/sandbox/index.js';
import {
  ContainerBackend,
  resolveAgentImage,
} from '../lib/sandbox/container-common.js';
import {
  getDownloadCacheMounts,
  ensureDownloadCacheVolumes,
} from '../lib/sandbox/download-cache.js';
import {
  checkImageCache,
  waitForInitAndCommit,
} from '../lib/sandbox/container-image-cache.js';
import { exitWithError, exitWithSuccess } from '../utils/exit.js';
import type { CommandDefinition } from '../types.js';
import type { BuildOutput } from '../output-types.js';
import { getTelemetry } from '../lib/telemetry.js';
import { getUserAIAgent } from '../lib/agents/index.js';
import { getAIAgentTool } from '../lib/agents/index.js';

// Language packages
import { JavaScriptSandboxPackage } from '../lib/sandbox/languages/javascript.js';
import { TypeScriptSandboxPackage } from '../lib/sandbox/languages/typescript.js';
import { PHPSandboxPackage } from '../lib/sandbox/languages/php.js';
import { RustSandboxPackage } from '../lib/sandbox/languages/rust.js';
import { GoSandboxPackage } from '../lib/sandbox/languages/go.js';
import { PythonSandboxPackage } from '../lib/sandbox/languages/python.js';
import { RubySandboxPackage } from '../lib/sandbox/languages/ruby.js';
import { DartSandboxPackage } from '../lib/sandbox/languages/dart.js';

// Package manager packages
import { NpmSandboxPackage } from '../lib/sandbox/package-managers/npm.js';
import { PnpmSandboxPackage } from '../lib/sandbox/package-managers/pnpm.js';
import { YarnSandboxPackage } from '../lib/sandbox/package-managers/yarn.js';
import { ComposerSandboxPackage } from '../lib/sandbox/package-managers/composer.js';
import { CargoSandboxPackage } from '../lib/sandbox/package-managers/cargo.js';
import { GomodSandboxPackage } from '../lib/sandbox/package-managers/gomod.js';
import { PipSandboxPackage } from '../lib/sandbox/package-managers/pip.js';
import { PoetrySandboxPackage } from '../lib/sandbox/package-managers/poetry.js';
import { UvSandboxPackage } from '../lib/sandbox/package-managers/uv.js';
import { RubygemsSandboxPackage } from '../lib/sandbox/package-managers/rubygems.js';
import { PubSandboxPackage } from '../lib/sandbox/package-managers/pub.js';

// Task manager packages
import { JustSandboxPackage } from '../lib/sandbox/task-managers/just.js';
import { MakeSandboxPackage } from '../lib/sandbox/task-managers/make.js';
import { TaskSandboxPackage } from '../lib/sandbox/task-managers/task.js';

import type { SandboxPackage } from '../lib/sandbox/types.js';
import { getDependencyResolutionCommands } from '../lib/dependency-resolution.js';
import { shellEscape } from '../utils/shell.js';

function getPackages(projectConfig: ProjectConfigManager): SandboxPackage[] {
  const packages: SandboxPackage[] = [];
  const langMap: Record<string, () => SandboxPackage> = {
    javascript: () => new JavaScriptSandboxPackage(),
    typescript: () => new TypeScriptSandboxPackage(),
    php: () => new PHPSandboxPackage(),
    rust: () => new RustSandboxPackage(),
    go: () => new GoSandboxPackage(),
    python: () => new PythonSandboxPackage(),
    ruby: () => new RubySandboxPackage(),
    dart: () => new DartSandboxPackage(),
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

  for (const lang of projectConfig.allLanguages ?? []) {
    if (langMap[lang]) packages.push(langMap[lang]());
  }
  for (const pm of projectConfig.allPackageManagers ?? []) {
    if (pmMap[pm]) packages.push(pmMap[pm]());
  }
  for (const tm of projectConfig.allTaskManagers ?? []) {
    if (tmMap[tm]) packages.push(tmMap[tm]());
  }
  return packages;
}

function generateProjectRepositorySyncSection(
  projectConfig: ProjectConfigManager
): string {
  const projectsWithRepositories = (projectConfig.projects || []).filter(
    project => project.repository
  );

  if (projectsWithRepositories.length === 0) {
    return '';
  }

  const syncBlocks = projectsWithRepositories.map(project => {
    const targetPath = `/workspace/${project.path}`;
    const escapedName = shellEscape(project.name);
    const escapedPath = shellEscape(targetPath);
    const escapedRepository = shellEscape(project.repository!);
    const escapedRef = project.ref ? shellEscape(project.ref) : '';

    const checkoutRef = project.ref
      ? `
echo "🔀 Checking out ${escapedRef} for ${escapedName}"
if git -C ${escapedPath} rev-parse --verify refs/remotes/origin/${escapedRef} >/dev/null 2>&1; then
  git -C ${escapedPath} checkout -B ${escapedRef} refs/remotes/origin/${escapedRef}
elif git -C ${escapedPath} rev-parse --verify ${escapedRef} >/dev/null 2>&1; then
  git -C ${escapedPath} checkout --detach ${escapedRef}
else
  echo "❌ Could not resolve ref ${escapedRef} in ${escapedName}"
  safe_exit 1
fi
`
      : `
default_remote_ref=$(git -C ${escapedPath} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -z "$default_remote_ref" ]; then
  echo "❌ Could not determine default remote branch for ${escapedName}"
  safe_exit 1
fi
default_branch="\${default_remote_ref#origin/}"
echo "🔀 Checking out default branch $default_branch for ${escapedName}"
git -C ${escapedPath} checkout -B "$default_branch" "$default_remote_ref"
`;

    return `echo "📥 Syncing child repository ${escapedName} for build cache"
mkdir -p "$(dirname ${escapedPath})"
if [ ! -d ${escapedPath}/.git ]; then
  rm -rf ${escapedPath}
  git clone ${escapedRepository} ${escapedPath}
else
  current_origin=$(git -C ${escapedPath} remote get-url origin 2>/dev/null || true)
  if [ "$current_origin" != ${escapedRepository} ]; then
    echo "❌ Existing repository at ${escapedPath} points to a different origin"
    safe_exit 1
  fi
fi
if ! git -C ${escapedPath} fetch --all --tags --prune; then
  echo "❌ Failed to fetch repository ${escapedName}"
  safe_exit 1
fi
${checkoutRef}
git -C ${escapedPath} reset --hard HEAD
git -C ${escapedPath} clean -fd
echo "✅ Repository ${escapedName} is ready for build caching"`;
  });

  return `
# Materialize external project repositories into the staged workspace so
# multi-repo dependency setup can be baked into the cache image.
echo -e "\\n======================================="
echo "📥 Syncing external repositories for cache build"
echo "======================================="
${syncBlocks.join('\n')}
`;
}

function generateBuildEntrypoint(
  agent: string,
  projectConfig: ProjectConfigManager,
  targetUid?: number,
  targetGid?: number
): string {
  const allPackages = getPackages(projectConfig);

  const installScripts: string[] = [];
  for (const pkg of allPackages) {
    const install = pkg.installScript();
    if (install.trim()) {
      installScripts.push(`echo "Installing ${pkg.name}..."`);
      installScripts.push(install);
    }
    const init = pkg.initScript();
    if (init.trim()) {
      installScripts.push(`echo "Initializing ${pkg.name}..."`);
      installScripts.push(init);
    }
  }

  const rootInitScripts = projectConfig.allInitScripts ?? [];
  const initScriptBlocks = rootInitScripts.map(entry => {
    const workspaceScript = entry.path
      ? `/workspace/${entry.path}/${entry.script}`
      : `/workspace/${entry.script}`;
    const workspaceDir = entry.path ? `/workspace/${entry.path}` : '/workspace';
    const label = entry.path ? ` (${entry.path})` : '';

    return `echo "🔧 Running initialization script${label}"
cd ${JSON.stringify(workspaceDir)}
bash ${JSON.stringify(workspaceScript)}
echo "✅ Initialization script${label} completed successfully"`;
  });

  const initScriptSection =
    initScriptBlocks.length > 0
      ? `
# Run root and project init scripts after project repositories have been
# materialized into the writable build workspace.
${initScriptBlocks.join('\n')}
`
      : '';

  const dependencyResolutionCommands = getDependencyResolutionCommands({
    rootPackageManagers: projectConfig.packageManagers ?? [],
    projects: projectConfig.projects,
  });
  const dependencyResolutionSection =
    dependencyResolutionCommands.length > 0
      ? `
# Resolve root and project dependencies in the staged build workspace.
${dependencyResolutionCommands.join('\n')}
`
      : '';

  const mcps = projectConfig.mcps ?? [];
  let mcpSection = '';
  if (mcps.length > 0) {
    const mcpCmds = mcps.map(mcp => {
      let cmd = `rover-agent config mcp ${agent} '${mcp.name}' --transport '${mcp.transport}'`;
      for (const env of mcp.envs ?? []) cmd += ` --env '${env}'`;
      for (const header of mcp.headers ?? []) cmd += ` --header '${header}'`;
      cmd += ` '${mcp.commandOrUrl}'`;
      return cmd;
    });
    mcpSection = `
# Configure MCPs
rover-agent config mcp ${agent} package-manager --transport "http" http://127.0.0.1:8090/mcp
${mcpCmds.join('\n')}
`;
  } else {
    mcpSection = `
# Configure built-in MCP
rover-agent config mcp ${agent} package-manager --transport "http" http://127.0.0.1:8090/mcp
`;
  }

  return `#!/usr/bin/env bash
set -euo pipefail

AGENT="${agent}"

safe_exit() {
  exit "\${1:-1}"
}

# Home setup — running as root during build
export HOME=/home/agent
mkdir -p $HOME $HOME/.config $HOME/.local/bin
echo 'export PATH="$HOME/.local/bin:$HOME/.local/npm/bin:$PATH"' >> $HOME/.profile

source $HOME/.profile

# Update package lists
if [[ -f /etc/debian_version ]]; then
  sudo apt-get update -qq
fi

# Create a writable build workspace from the read-only host project mount.
export BUILD_WORKSPACE=/tmp/rover-build-workspace
rm -rf "$BUILD_WORKSPACE"
mkdir -p "$BUILD_WORKSPACE"
cp -a /workspace-src/. "$BUILD_WORKSPACE/"
rm -rf /workspace 2>/dev/null || true
ln -s "$BUILD_WORKSPACE" /workspace

# Install languages, package managers, task managers
${installScripts.join('\n')}

echo "Installing agent CLI ($AGENT)..."
sudo -E rover-agent install $AGENT || echo "Agent install failed (non-fatal for build)"
sudo chown -R $(id -u):$(id -g) $HOME

# Copy credentials
echo "Copying agent credentials..."
sudo rover-agent-install $AGENT || true
for _cred_dir in $HOME/.codex $HOME/.claude $HOME/.config/github-copilot $HOME/.gemini $HOME/.qwen $HOME/.opencode; do
  [ -d "$_cred_dir" ] && sudo chown -R $(id -u):$(id -g) "$_cred_dir"
done

${generateProjectRepositorySyncSection(projectConfig)}

${dependencyResolutionSection}

${initScriptSection}

${mcpSection}

# Pre-chown HOME to the target container user so the runtime entrypoint
# can skip the expensive recursive chown (saves 1-3+ minutes per start).
${targetUid != null ? `chown -R ${targetUid}:${targetGid ?? targetUid} $HOME 2>/dev/null || true` : '# No target UID specified — skip pre-chown'}

# Make HOME world-writable so the image works with any --user UID:GID.
# The actual task entrypoint does chown, but we set permissive defaults
# so the image is immediately usable (e.g. by verify, shell, etc.)
chmod -R a+rwX $HOME 2>/dev/null || true

# Make download cache volumes world-writable so non-root task containers
# can reuse cached downloads (apt debs, pub/npm/go packages, etc.)
for _dlcache_dir in /var/cache/apt; do
  [ -d "$_dlcache_dir" ] && chmod -R a+rwX "$_dlcache_dir" 2>/dev/null || true
done

# Mark all directories as git-safe so they work with any UID
git config --system --add safe.directory '*' 2>/dev/null || true

echo ""
echo "Build complete!"
exec "$@"
`;
}

const buildCommand = async (
  options: { json?: boolean; agent?: string; force?: boolean } = {}
) => {
  const telemetry = getTelemetry();
  const jsonOutput: BuildOutput = { success: true };

  try {
    const projectPath = getProjectPath() || process.cwd();
    const projectConfig = ProjectConfigManager.load(projectPath);
    const agent = options.agent ?? getUserAIAgent() ?? 'claude';

    if (!isJsonMode()) {
      showTitle('Build Cache Image');
      showProperties({
        Project: projectPath,
        Agent: agent,
        Languages: (projectConfig.allLanguages ?? []).join(', ') || '-',
        'Package managers':
          (projectConfig.allPackageManagers ?? []).join(', ') || '-',
      });
      console.log();
    }

    // 1. Detect container backend
    const backendName = await getAvailableSandboxBackend();
    if (!backendName) {
      jsonOutput.success = false;
      jsonOutput.error =
        'No container backend available. Install Docker or Podman.';
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    const backend =
      backendName === 'docker'
        ? ContainerBackend.Docker
        : ContainerBackend.Podman;

    // 2. Resolve agent image
    const agentImage = resolveAgentImage(projectConfig, undefined);

    // 3. Check if cache already exists
    const { hasCachedImage, cacheTag } = checkImageCache(
      backend,
      projectConfig,
      agentImage,
      agent
    );

    if (hasCachedImage && !options.force) {
      if (!isJsonMode()) {
        console.log(
          colors.green('Cache image already exists: ') + colors.cyan(cacheTag)
        );
        console.log(colors.gray('Use --force to rebuild'));
      }
      jsonOutput.cacheTag = cacheTag;
      jsonOutput.cached = true;
      await exitWithSuccess(null, jsonOutput, { telemetry });
      return;
    }

    if (!isJsonMode()) {
      if (hasCachedImage) {
        console.log(colors.yellow('Rebuilding cache image (--force)...'));
      } else {
        console.log('Building cache image...');
      }
      console.log(colors.gray(`  Base image: ${agentImage}`));
      console.log(colors.gray(`  Cache tag:  ${cacheTag}`));
      console.log();
    }

    // 4. Generate entrypoint script
    const tmpDir = join(tmpdir(), `rover-build-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const entrypointPath = join(tmpDir, 'entrypoint.sh');
    const hostUser = userInfo();
    writeFileSync(
      entrypointPath,
      generateBuildEntrypoint(agent, projectConfig, hostUser.uid, hostUser.gid)
    );
    chmodSync(entrypointPath, 0o755);

    // 5. Create init-only container
    // Run as root (no --user, no passwd/group mounts) so apt post-install
    // scripts can freely modify /etc/group and /etc/passwd. The cache image
    // will be used later with proper user mapping via tmpUserGroupFiles.
    const containerName = `rover-build-${Date.now()}`;
    const startTime = Date.now();

    try {
      await launch(backendName, ['rm', '-f', containerName]);
    } catch {
      // ignore
    }

    const dockerArgs = [
      'create',
      '--name',
      containerName,
      '-v',
      `${projectPath}:/workspace-src:Z,ro`,
      '-v',
      `${entrypointPath}:/entrypoint.sh:Z,ro`,
      '--entrypoint',
      '/entrypoint.sh',
    ];

    // Add agent-specific mounts (credential files)
    try {
      const agentTool = getAIAgentTool(agent);
      dockerArgs.push(...agentTool.getContainerMounts());
    } catch {
      // Agent tool not found — skip mounts
    }

    // Mount download cache volumes so apt/pub/npm/go downloads are cached
    // across builds. These are named volumes — their content is NOT captured
    // by docker commit, which is intentional: the installed artifacts end up
    // in the image filesystem, while the download caches persist in volumes
    // for subsequent builds to reuse.
    ensureDownloadCacheVolumes(backend, projectConfig);
    dockerArgs.push(...getDownloadCacheMounts(projectConfig));

    // Add extra args from project config, but NOT volume mounts.
    // Volume mounts are excluded during build so that all installed content
    // (languages, package caches) is baked into the committed image rather
    // than going into named volumes that docker commit ignores.
    // This way the cache image is self-contained and works without volumes.
    const configExtraArgs = projectConfig.sandboxExtraArgs ?? [];
    for (let i = 0; i < configExtraArgs.length; i++) {
      const arg = configExtraArgs[i];
      if (arg === '-v' || arg === '--volume') {
        // Skip -v and its value
        i++;
        continue;
      }
      // Skip --volume=... form
      if (arg.startsWith('--volume=') || arg.startsWith('-v=')) {
        continue;
      }
      dockerArgs.push(arg);
    }

    // Init-only: run entrypoint then exit with 'true'
    dockerArgs.push(agentImage, 'true');

    if (!isJsonMode()) {
      console.log('Creating build container...');
    }

    await launch(backendName, dockerArgs);

    if (!isJsonMode()) {
      console.log(
        'Running setup (installing languages, tools, dependencies)...'
      );
    }

    await launch(backendName, ['start', '-a', containerName]);

    // 7. Wait for init to finish and commit as cache image
    const committed = await waitForInitAndCommit(
      backend,
      containerName,
      cacheTag,
      projectPath,
      agent
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    if (committed) {
      if (!isJsonMode()) {
        console.log();
        console.log(colors.green(`Cache image built in ${elapsed}s`));
        console.log(colors.cyan(`  Tag: ${cacheTag}`));
        console.log();
        console.log(
          colors.gray(
            'Future tasks will use this cached image for faster startup.'
          )
        );
      }
      jsonOutput.cacheTag = cacheTag;
      jsonOutput.elapsed = parseFloat(elapsed);
      jsonOutput.cached = false;
      await exitWithSuccess(null, jsonOutput, { telemetry });
    } else {
      jsonOutput.success = false;
      jsonOutput.error = 'Container init failed — image was not committed';
      await exitWithError(jsonOutput, { telemetry });
    }
  } catch (error) {
    jsonOutput.success = false;
    jsonOutput.error = error instanceof Error ? error.message : String(error);
    await exitWithError(jsonOutput, { telemetry });
  }
};

export { buildCommand };
export { generateBuildEntrypoint };

export default {
  name: 'build',
  description: 'Build the container cache image for a project',
  requireProject: true,
  action: buildCommand,
} satisfies CommandDefinition;
