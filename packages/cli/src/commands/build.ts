import colors from 'ansi-colors';
import {
  writeFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getBuildContainerExtraArgs,
  getInitScriptMounts,
  getRootInitScriptMountPath,
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
import { getUserAIAgent, getAIAgentTool } from '../lib/agents/index.js';

import { getPackagesFromConfig } from '../lib/sandbox/packages.js';
import { getDependencyResolutionCommands } from '../lib/dependency-resolution.js';
import {
  isSafeRelativePath,
  resolvePathWithinRoot,
} from '../utils/path-safety.js';
import { shellEscape } from '../utils/shell.js';

interface BuildRepositoryMount {
  hostPath: string;
  containerPath: string;
}

function isLocalRepositoryReference(repository: string): boolean {
  return (
    repository.startsWith('file://') ||
    (isAbsolute(repository) && !repository.startsWith('/workspace/')) ||
    repository === '.' ||
    repository === '..' ||
    repository.startsWith('./') ||
    repository.startsWith('../')
  );
}

export function prepareBuildProjectConfig(
  projectPath: string,
  projectConfig: ProjectConfigManager
): {
  buildProjectConfig: ProjectConfigManager;
  repositoryMounts: BuildRepositoryMount[];
} {
  const repositoryMounts: BuildRepositoryMount[] = [];
  const repositoryResolutionRoot = projectConfig.projectRoot ?? projectPath;
  const buildProjects = (projectConfig.projects ?? []).flatMap(
    (project, index) => {
      const projectPathIsSafe =
        typeof project.path === 'string' &&
        (typeof projectConfig.projectRoot !== 'string'
          ? isSafeRelativePath(project.path)
          : resolvePathWithinRoot(projectConfig.projectRoot, project.path) !==
            null);
      if (!projectPathIsSafe) {
        // Exclude projects with unsafe paths — they cannot be safely
        // mounted or cloned inside the container.
        return [];
      }

      if (
        typeof project.repository !== 'string' ||
        !isLocalRepositoryReference(project.repository)
      ) {
        return [project];
      }

      const hostPath = project.repository.startsWith('file://')
        ? fileURLToPath(project.repository)
        : resolve(repositoryResolutionRoot, project.repository);

      if (!existsSync(hostPath)) {
        throw new Error(
          `Local workspace repository for ${project.name} not found: ${hostPath}`
        );
      }

      const containerPath = `/workspace-repos/${index}`;
      repositoryMounts.push({ hostPath, containerPath });

      return [
        {
          ...project,
          repository: containerPath,
        },
      ];
    }
  );

  return {
    buildProjectConfig: new ProjectConfigManager(
      {
        ...projectConfig.toJSON(),
        projects: buildProjects,
      },
      projectConfig.projectRoot ?? projectPath
    ),
    repositoryMounts,
  };
}

function generateProjectRepositorySyncSection(
  projectConfig: ProjectConfigManager
): string {
  const projectsWithRepositories = (projectConfig.projects || []).filter(
    project =>
      project.repository &&
      typeof project.path === 'string' &&
      (typeof projectConfig.projectRoot !== 'string'
        ? isSafeRelativePath(project.path)
        : resolvePathWithinRoot(projectConfig.projectRoot, project.path) !==
          null)
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
if [ -n "$default_remote_ref" ]; then
  default_branch="\${default_remote_ref#origin/}"
  echo "🔀 Checking out default branch $default_branch for ${escapedName}"
  git -C ${escapedPath} checkout -B "$default_branch" "$default_remote_ref"
else
  echo "🔀 Remote HEAD not advertised for ${escapedName}; using cloned default checkout"
fi
`;

    return `echo "📥 Syncing child repository ${escapedName} for build cache"
mkdir -p "$(dirname ${escapedPath})"
if [ -d ${escapedPath}/.git ]; then
  current_origin=$(git -C ${escapedPath} remote get-url origin 2>/dev/null || true)
  if [ "$current_origin" != ${escapedRepository} ]; then
    echo "❌ Existing repository at ${escapedPath} points to a different origin"
    safe_exit 1
  fi
fi
rm -rf ${escapedPath}
if ! git clone ${escapedRepository} ${escapedPath}; then
  echo "❌ Failed to clone repository ${escapedName}"
  safe_exit 1
fi
if ! git -C ${escapedPath} fetch --all --tags --prune; then
  echo "❌ Failed to fetch repository ${escapedName}"
  safe_exit 1
fi
${checkoutRef}
git -C ${escapedPath} reset --hard HEAD
# Remove ignored files too so copied local checkouts cannot leak state into
# dependency resolution or init scripts inside the cache build.
git -C ${escapedPath} clean -fdx
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
  const isSafeProjectPath = (projectPath: string): boolean =>
    typeof projectConfig.projectRoot !== 'string'
      ? isSafeRelativePath(projectPath)
      : resolvePathWithinRoot(projectConfig.projectRoot, projectPath) !== null;

  const allPackages = getPackagesFromConfig(projectConfig);

  const installScripts: string[] = [];
  for (const pkg of allPackages) {
    const install = pkg.installScript();
    if (install.trim()) {
      const safeName = pkg.name.replace(/["`$\\]/g, '');
      installScripts.push(`echo "Installing ${safeName}..."`);
      installScripts.push(install);
    }
    const init = pkg.initScript();
    if (init.trim()) {
      const safeName = pkg.name.replace(/["`$\\]/g, '');
      installScripts.push(`echo "Initializing ${safeName}..."`);
      installScripts.push(init);
    }
  }

  const rootInitScripts = projectConfig.allInitScripts ?? [];
  const initScriptBlocks = rootInitScripts
    .filter(entry => !entry.path || isSafeProjectPath(entry.path))
    .map((entry, index) => {
      const label = entry.path ? ` (${entry.path})` : '';

      if (entry.path) {
        return `echo "🔧 Running initialization script${label}"
workspace_project_script_${index}=${shellEscape(`/workspace/${entry.path}/${entry.script}`)}
workspace_root_script_${index}=${shellEscape(`/workspace/${entry.script}`)}
if [ -f "$workspace_project_script_${index}" ]; then
  workspace_script_${index}="$workspace_project_script_${index}"
  workspace_dir_${index}=${shellEscape(`/workspace/${entry.path}`)}
elif [ -f "$workspace_root_script_${index}" ]; then
  workspace_script_${index}="$workspace_root_script_${index}"
  workspace_dir_${index}='/workspace'
else
  echo "❌ Initialization script${label} not found at $workspace_project_script_${index} or $workspace_root_script_${index}"
  safe_exit 1
fi
cd "$workspace_dir_${index}"
bash "$workspace_script_${index}"
echo "✅ Initialization script${label} completed successfully"`;
      }

      const mountedScript = getRootInitScriptMountPath(rootInitScripts, index);
      const workspaceScript = `/workspace/${entry.script}`;
      const workspaceDir = '/workspace';
      return `echo "🔧 Running initialization script${label}"
mounted_script_${index}=${shellEscape(mountedScript)}
workspace_script_${index}=${shellEscape(workspaceScript)}
if [ -f "$mounted_script_${index}" ]; then
  root_script_${index}="$mounted_script_${index}"
elif [ -f "$workspace_script_${index}" ]; then
  root_script_${index}="$workspace_script_${index}"
else
  echo "❌ Initialization script${label} not found at $mounted_script_${index} or $workspace_script_${index}"
  safe_exit 1
fi
cd ${shellEscape(workspaceDir)}
bash "$root_script_${index}"
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
    workspaceRoot: projectConfig.projectRoot,
  });
  const dependencyResolutionSection =
    dependencyResolutionCommands.length > 0
      ? `
# Resolve root and project dependencies in the staged build workspace.
${dependencyResolutionCommands.join('\n')}
`
      : '';

  const mcps = projectConfig.mcps ?? [];
  // rover-agent commands only accept the agent name (e.g. "claude"), not
  // the full agent:model string (e.g. "claude:haiku").
  const agentName = agent.split(':')[0];
  let mcpSection = '';
  if (mcps.length > 0) {
    const mcpCmds = mcps.map(mcp => {
      let cmd = `rover-agent config mcp ${shellEscape(agentName)} ${shellEscape(mcp.name)} --transport ${shellEscape(mcp.transport)}`;
      for (const env of mcp.envs ?? []) cmd += ` --env ${shellEscape(env)}`;
      for (const header of mcp.headers ?? [])
        cmd += ` --header ${shellEscape(header)}`;
      cmd += ` ${shellEscape(mcp.commandOrUrl)}`;
      return cmd;
    });
    mcpSection = `
# Configure MCPs
rover-agent config mcp ${shellEscape(agentName)} package-manager --transport "http" http://127.0.0.1:8090/mcp
${mcpCmds.join('\n')}
`;
  } else {
    mcpSection = `
# Configure built-in MCP
rover-agent config mcp ${shellEscape(agentName)} package-manager --transport "http" http://127.0.0.1:8090/mcp
`;
  }

  return `#!/usr/bin/env bash
set -euo pipefail

AGENT=${shellEscape(agent)}
# Strip model suffix (e.g. "claude:haiku" → "claude") for commands that
# only accept the agent name.
AGENT_NAME="\${AGENT%%:*}"

safe_exit() {
  exit "\${1:-1}"
}

# Detect sudo availability once for use throughout the build script.
_SUDO=""
if command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
  _SUDO="sudo"
fi

run_as_root() {
  if [ -n "$_SUDO" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

run_as_root_with_env() {
  if [ -n "$_SUDO" ]; then
    sudo -E "$@"
  else
    "$@"
  fi
}

# Home setup — running as root during build
export HOME=/home/agent
mkdir -p $HOME $HOME/.config $HOME/.local/bin
echo 'export PATH="$HOME/.local/bin:$HOME/.local/npm/bin:$PATH"' >> $HOME/.profile

source $HOME/.profile

# Update package lists
if [[ -f /etc/debian_version ]]; then
  run_as_root apt-get update -qq
fi

# Create a writable build workspace from the read-only host project mount.
# The host project is mounted read-only at /workspace-src. We copy it to a
# writable location and symlink /workspace to it. If /workspace is a mount
# point (cannot be removed), the symlink will fail and the build will error
# out on subsequent steps that write to /workspace — this is intentional.
export BUILD_WORKSPACE=/tmp/rover-build-workspace
rm -rf "$BUILD_WORKSPACE"
mkdir -p "$BUILD_WORKSPACE"
cp -a /workspace-src/. "$BUILD_WORKSPACE/"
rm -rf /workspace 2>/dev/null || true
ln -s "$BUILD_WORKSPACE" /workspace

echo "Installing agent CLI ($AGENT_NAME)..."
run_as_root_with_env rover-agent install $AGENT_NAME || echo "Agent install failed (non-fatal for build)"
run_as_root chown -R $(id -u):$(id -g) $HOME

# Copy credentials
echo "Copying agent credentials..."
run_as_root rover-agent-install $AGENT_NAME || true
for _cred_dir in $HOME/.codex $HOME/.claude $HOME/.config/github-copilot $HOME/.gemini $HOME/.qwen $HOME/.opencode; do
  [ -d "$_cred_dir" ] && run_as_root chown -R $(id -u):$(id -g) "$_cred_dir"
done

# Mark all directories as git-safe so they work with any UID.
# Must run before syncing external repositories so clones from bind-mounted
# bare repos don't fail with "dubious ownership" errors.
git config --global --add safe.directory '*' 2>/dev/null || true
git config --system --add safe.directory '*' 2>/dev/null || true

${generateProjectRepositorySyncSection(projectConfig)}

# Install languages, package managers, task managers after child repositories
# are synced so installers can inspect child-repo manifests for versions.
${installScripts.join('\n')}

${initScriptSection}

${dependencyResolutionSection}

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
    const { buildProjectConfig, repositoryMounts } = prepareBuildProjectConfig(
      projectPath,
      projectConfig
    );
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

    // 3. Check if cache already exists.
    // Use the agent name without model suffix for cache hashing so that
    // `rover build -a claude:haiku` and `rover task -a claude:haiku` (which
    // stores agent="claude") produce the same hash.
    const agentNameForCache = agent.split(':')[0];
    const { hasCachedImage, cacheTag } = checkImageCache(
      backend,
      projectConfig,
      agentImage,
      agentNameForCache
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
      generateBuildEntrypoint(
        agent,
        buildProjectConfig,
        hostUser.uid,
        hostUser.gid
      )
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

    for (const repositoryMount of repositoryMounts) {
      dockerArgs.push(
        '-v',
        `${repositoryMount.hostPath}:${repositoryMount.containerPath}:Z,ro`
      );
    }

    dockerArgs.push(...getInitScriptMounts(buildProjectConfig));

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
    dockerArgs.push(
      ...getBuildContainerExtraArgs(projectConfig.sandboxExtraArgs)
    );

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

    // 6. Start container and stream build output. Don't throw on non-zero
    //    exit — let waitForInitAndCommit handle cleanup and commit decisions.
    await launch(backendName, ['start', '-a', containerName], {
      reject: false,
    });

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
