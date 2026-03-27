import {
  writeFileSync,
  chmodSync,
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TaskDescriptionManager,
  IterationManager,
  PreContextDataManager,
  ProjectConfigManager,
  launchSync,
  VERBOSE,
} from 'rover-core';
import type { PreviousIteration } from 'rover-schemas';
import entrypointScript from './entrypoint.sh';
import pupa from 'pupa';
import type { SandboxPackage } from './sandbox/types.js';
import { mergeNetworkConfig, generateNetworkScript } from './network-config.js';
import { initWorkflowStore } from './workflow.js';
import { getDependencyResolutionCommands } from './dependency-resolution.js';
import { shellEscape } from '../utils/shell.js';
import {
  isSafeRelativePath,
  resolvePathWithinRoot,
} from '../utils/path-safety.js';

import { getRootInitScriptMountPath } from './sandbox/container-common.js';
import { getPackagesFromConfig } from './sandbox/packages.js';

/**
 * SetupBuilder class - Consolidates Docker setup script generation
 * Replaces the existing docker-setup.sh and docker-setup-gemini.sh files
 */
export class SetupBuilder {
  private repositoryMounts: Array<{
    hostPath: string;
    containerPath: string;
  }> = [];
  private agent: string;
  private task: TaskDescriptionManager;
  private taskBasePath: string;
  private iterationPath: string;
  private isDockerRootless: boolean;
  private projectConfig: ProjectConfigManager;
  private resumeFromCheckpoint: boolean;
  private workspaceProjects: Array<{
    name: string;
    path: string;
    repository?: string;
    runtimeRepository?: string;
    ref?: string;
    languages?: string[];
    packageManagers?: string[];
  }>;

  constructor(
    taskDescription: TaskDescriptionManager,
    agent: string,
    projectConfig: ProjectConfigManager,
    options: { resumeFromCheckpoint?: boolean } = {}
  ) {
    this.agent = agent;
    this.task = taskDescription;
    this.projectConfig = projectConfig;
    this.resumeFromCheckpoint = options.resumeFromCheckpoint === true;

    let isDockerRootless = false;

    try {
      const dockerInfo = launchSync('docker', ['info', '-f', 'json']).stdout;
      if (dockerInfo) {
        const info = JSON.parse(dockerInfo.toString());
        isDockerRootless = (info?.SecurityOptions || []).some((value: string) =>
          value.includes('rootless')
        );
      }
    } catch {
      // Docker may not be available (e.g. Podman-only environment)
    }

    this.isDockerRootless = isDockerRootless;

    // Set up paths using TaskDescriptionManager methods
    this.taskBasePath = this.task.getBasePath();
    this.iterationPath = this.task.getIterationPath();
    this.workspaceProjects = this.resolveWorkspaceProjects();

    // Ensures the directories exist
    mkdirSync(this.iterationPath, { recursive: true });
  }

  private resolveWorkspaceProjects(): Array<{
    name: string;
    path: string;
    repository?: string;
    runtimeRepository?: string;
    ref?: string;
    languages?: string[];
    packageManagers?: string[];
  }> {
    const persistedProjects = this.getPersistedWorkspaceProjects();
    if (persistedProjects !== undefined) {
      return persistedProjects;
    }

    return (this.projectConfig.projects ?? []).flatMap((project, index) => {
      if (
        typeof project?.name !== 'string' ||
        typeof project?.path !== 'string' ||
        !this.isSafeWorkspacePath(project.path)
      ) {
        return [];
      }

      const repositoryMount = this.resolveRepositoryMount(
        project.repository,
        index
      );

      return [
        {
          name: project.name,
          path: project.path,
          repository: project.repository,
          runtimeRepository:
            repositoryMount?.containerPath ?? project.repository,
          ref: project.ref,
          languages: project.languages ?? [],
          packageManagers: project.packageManagers ?? [],
        },
      ];
    });
  }

  private getPersistedWorkspaceProjects():
    | Array<{
        name: string;
        path: string;
        repository?: string;
        runtimeRepository?: string;
        ref?: string;
        languages?: string[];
        packageManagers?: string[];
      }>
    | undefined {
    const parsePersistedWorkspaceProjects = (
      descriptionPath: string
    ):
      | Array<{
          name: string;
          path: string;
          repository?: string;
          runtimeRepository?: string;
          ref?: string;
          languages?: string[];
          packageManagers?: string[];
        }>
      | undefined => {
      try {
        const parsed = JSON.parse(readFileSync(descriptionPath, 'utf8')) as {
          projects?: Array<{
            name?: unknown;
            path?: unknown;
            repository?: unknown;
            ref?: unknown;
            languages?: unknown;
            packageManagers?: unknown;
          }>;
        };

        return (Array.isArray(parsed.projects) ? parsed.projects : []).flatMap(
          (project, index) => {
            if (
              typeof project?.name !== 'string' ||
              typeof project?.path !== 'string' ||
              !this.isSafeWorkspacePath(project.path)
            ) {
              return [];
            }

            const repository =
              typeof project.repository === 'string'
                ? project.repository
                : undefined;
            const repositoryMount = this.resolveRepositoryMount(
              repository,
              index
            );

            return [
              {
                name: project.name,
                path: project.path,
                repository,
                runtimeRepository: repositoryMount?.containerPath ?? repository,
                ref: typeof project.ref === 'string' ? project.ref : undefined,
                languages: Array.isArray(project.languages)
                  ? project.languages.filter(
                      (language): language is string =>
                        typeof language === 'string'
                    )
                  : [],
                packageManagers: Array.isArray(project.packageManagers)
                  ? project.packageManagers.filter(
                      (pm): pm is string => typeof pm === 'string'
                    )
                  : [],
              },
            ];
          }
        );
      } catch {
        return undefined;
      }
    };
    const legacyDescriptionPath = this.task.worktreePath
      ? join(this.task.worktreePath, '.rover-workspace.json')
      : join(this.taskBasePath, '.rover-workspace.json');

    const iterationsPath = join(this.taskBasePath, 'iterations');
    if (!existsSync(iterationsPath)) {
      return existsSync(legacyDescriptionPath)
        ? (parsePersistedWorkspaceProjects(legacyDescriptionPath) ?? [])
        : undefined;
    }

    const iterationIds = readdirSync(iterationsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => Number.parseInt(dirent.name, 10))
      .filter(iteration => !Number.isNaN(iteration))
      .sort((a, b) => b - a);

    if (iterationIds.length === 0) {
      return existsSync(legacyDescriptionPath)
        ? (parsePersistedWorkspaceProjects(legacyDescriptionPath) ?? [])
        : undefined;
    }

    let foundPersistedWorkspaceDescription = false;

    for (const iterationId of iterationIds) {
      const descriptionPath = join(
        iterationsPath,
        iterationId.toString(),
        'workspace-description.json'
      );
      if (!existsSync(descriptionPath)) {
        continue;
      }
      foundPersistedWorkspaceDescription = true;
      const persistedProjects =
        parsePersistedWorkspaceProjects(descriptionPath);
      if (persistedProjects !== undefined) {
        return persistedProjects;
      }
    }

    if (existsSync(legacyDescriptionPath)) {
      return parsePersistedWorkspaceProjects(legacyDescriptionPath) ?? [];
    }

    return foundPersistedWorkspaceDescription ? [] : undefined;
  }

  private isSafeWorkspacePath(relativePath: string): boolean {
    return typeof this.projectConfig.projectRoot === 'string'
      ? resolvePathWithinRoot(this.projectConfig.projectRoot, relativePath) !==
          null
      : isSafeRelativePath(relativePath);
  }

  private isLocalRepositoryReference(repository: string): boolean {
    return (
      repository.startsWith('file://') ||
      (isAbsolute(repository) && !repository.startsWith('/workspace/')) ||
      repository === '.' ||
      repository === '..' ||
      repository.startsWith('./') ||
      repository.startsWith('../')
    );
  }

  private resolveRepositoryMount(
    repository: unknown,
    index: number
  ): { hostPath: string; containerPath: string } | undefined {
    if (
      typeof repository !== 'string' ||
      !this.isLocalRepositoryReference(repository)
    ) {
      return undefined;
    }

    const hostPath = repository.startsWith('file://')
      ? fileURLToPath(repository)
      : resolve(this.projectConfig.projectRoot, repository);

    if (!existsSync(hostPath)) {
      throw new Error(`Local workspace repository not found: ${hostPath}`);
    }

    const containerPath = `/workspace-repos/${index}`;
    this.repositoryMounts.push({ hostPath, containerPath });
    return { hostPath, containerPath };
  }

  private getDependencyResolutionCommands(): string[] {
    return getDependencyResolutionCommands({
      rootPackageManagers: this.projectConfig.packageManagers ?? [],
      projects: this.workspaceProjects,
      workspaceRoot: this.projectConfig.projectRoot,
      addVenvPathExports: true,
    });
  }

  /**
   * Generate and save the setup script to the appropriate task directory
   */
  generateEntrypoint(
    includeTaskSetup: boolean = true,
    entrypointFilename: string = 'entrypoint.sh',
    useCachedImage: boolean = false
  ): string {
    let recoverPermissions = '';

    // For Docker rootless, force it to return the permissions to the right users.
    if (this.isDockerRootless) {
      recoverPermissions = `\n    sudo chown -R root:root /workspace || true
    sudo chown -R root:root /output || true\n`;
    }

    // --- apt-get update ---
    let aptGetUpdate = '';
    if (!useCachedImage) {
      aptGetUpdate = `# Update package lists on Debian-based distributions
if [[ -f /etc/debian_version ]]; then
  sudo apt-get update
fi`;
    }

    // --- home setup ---
    let homeSetup = '';
    if (useCachedImage) {
      // The entrypoint provisions the runtime HOME for remapped UIDs. Here we
      // only need to fix bind-mount ownership and load the cached profile.
      homeSetup = `sudo chown -R $(id -u):$(id -g) /workspace
sudo chown -R $(id -u):$(id -g) /output
sudo mkdir -p $HOME/.local/share/pnpm/store
sudo chmod -R a+rwX $HOME/.local/share/pnpm 2>/dev/null || true

source $HOME/.profile`;
    } else {
      homeSetup = `# Initially, use sudo to ensure even users without permissions can
# create this. Once we finish the setup, we will reduce the sudo
# permissions to the minimal.
sudo mkdir -p $HOME
sudo mkdir -p $HOME/.config
sudo mkdir -p $HOME/.local/bin
echo 'export PATH="$HOME/.local/bin:$HOME/.local/npm/bin:$PATH"' >> $HOME/.profile
sudo chown -R $(id -u):$(id -g) $HOME
sudo chown -R $(id -u):$(id -g) /logs
sudo chown -R $(id -u):$(id -g) /output
sudo chown -R $(id -u):$(id -g) /workspace

source $HOME/.profile`;
    }

    // SECURITY NOTE: Disabling git's directory ownership check with '*' is safe here
    // because this only runs inside ephemeral, single-user task containers where the
    // workspace is bind-mounted with a different UID than the container user.
    const gitSafeDirectorySetup = `# Allow git operations across mounted workspaces and embedded repositories.
# This is safe inside ephemeral task containers — the wildcard disables ownership
# checks that would otherwise block operations on bind-mounted directories.
git config --global --add safe.directory '*' 2>/dev/null || true
git config --system --add safe.directory '*' 2>/dev/null || true`;

    // --- workspace dependency resolution (runs even with cached images) ---
    // Some package managers (uv, poetry, pip -e) create virtualenvs in /workspace
    // which can't be done during image build (/workspace is read-only).
    // Resolve deps here since /workspace is now read-write.
    let workspaceDeps = '';
    const depCmds = this.getDependencyResolutionCommands();
    if (depCmds.length > 0) {
      workspaceDeps = depCmds.join('\n');
    }

    // --- package installation ---
    let installAllPackages = '';
    if (!useCachedImage) {
      const allPackages = getPackagesFromConfig(this.projectConfig);

      if (allPackages.length > 0) {
        const installScripts: string[] = [];

        for (const pkg of allPackages) {
          const script = pkg.installScript();
          if (script.trim()) {
            installScripts.push(`echo "📦 Installing ${pkg.name}..."`);
            installScripts.push(script);
            installScripts.push(`if [ $? -eq 0 ]; then
  echo "✅ ${pkg.name} installed successfully"
else
  echo "❌ Failed to install ${pkg.name}"
  safe_exit 1
fi`);
          }

          const initScript = pkg.initScript();
          if (initScript.trim()) {
            installScripts.push(`echo "🔧 Initializing ${pkg.name}..."`);
            installScripts.push(initScript);
            installScripts.push(`if [ $? -eq 0 ]; then
  echo "✅ ${pkg.name} initialized successfully"
else
  echo "❌ Failed to initialize ${pkg.name}"
  safe_exit 1
fi`);
          }
        }

        if (installScripts.length > 0) {
          installAllPackages = `
echo -e "\\n======================================="
echo "📦 Installing Languages, Package Managers, and Task Managers"
echo "======================================="
${installScripts.join('\n')}
`;
        }
      }
    }

    // --- agent install section ---
    let agentInstallSection = '';
    if (!useCachedImage) {
      agentInstallSection = `# Agent-specific CLI installation and credential setup
echo -e "\\n📦 Installing Agent CLI and setting up credentials"
# Pass the environment variables to ensure it loads the right credentials
sudo -E rover-agent install $AGENT

if [ $? -eq 0 ]; then
    echo "✅ $AGENT was installed successfully."
else
    echo "❌ $AGENT could not be installed"
    safe_exit 1
fi

# Set the right permissions after installing and moving credentials
sudo chown -R $(id -u):$(id -g) $HOME

echo -e "\\n📦 Done installing agent"`;
    }

    // --- credential install section ---
    // Always copy credentials on every container start (including cached images)
    // so that fresh credentials are available even when the image was cached.
    const credentialInstallSection = `# Copy credentials (runs on every start, including cached images)
echo -e "\\n📦 Copying agent credentials"
# Try with sudo first; fall back to non-sudo if sudo is broken (e.g. setuid
# bit lost in cached images). Credential files are mounted read-only at /
# and just need to be copied to $HOME — no root required for that.
if sudo -n true 2>/dev/null; then
  sudo rover-agent-install $AGENT
  _CRED_RC=$?
else
  rover-agent-install $AGENT
  _CRED_RC=$?
fi
# Only fix ownership of credential directories — avoid recursing the entire
# HOME tree which includes large SDK caches (Flutter, pub-cache, etc.) and
# can take 4+ minutes on every container start.
for _cred_dir in $HOME/.codex $HOME/.claude $HOME/.config/github-copilot $HOME/.gemini $HOME/.qwen $HOME/.opencode; do
  if [ -d "$_cred_dir" ]; then
    sudo chown -R $(id -u):$(id -g) "$_cred_dir" 2>/dev/null || chown -R $(id -u):$(id -g) "$_cred_dir" 2>/dev/null || true
  fi
done
if [ $_CRED_RC -ne 0 ]; then
  echo "⚠️  Credential install exited with code $_CRED_RC — agent may lack fresh credentials"
else
  echo "✅ Credentials copied successfully"
fi`;

    // --- MCP config section ---
    let mcpConfigSection = '';
    if (!useCachedImage) {
      // Generate MCP configuration commands from rover.json
      const mcps = this.projectConfig.mcps;
      let configureAllMCPCommands: string[] = [];

      if (mcps && mcps.length > 0) {
        configureAllMCPCommands.push('echo "✅ Configuring custom MCPs"');
        for (const mcp of mcps) {
          let cmd = `rover-agent config mcp ${shellEscape(this.agent)} ${shellEscape(mcp.name)} --transport ${shellEscape(mcp.transport)}`;

          if (mcp.envs && mcp.envs.length > 0) {
            for (const env of mcp.envs) {
              cmd += ` --env ${shellEscape(env)}`;
            }
          }

          if (mcp.headers && mcp.headers.length > 0) {
            for (const header of mcp.headers) {
              cmd += ` --header ${shellEscape(header)}`;
            }
          }

          cmd += ` ${shellEscape(mcp.commandOrUrl)}`;

          configureAllMCPCommands.push(cmd);
        }
      } else {
        configureAllMCPCommands.push(
          'echo "✅ No MCPs defined in rover.json, skipping custom MCP configuration"'
        );
      }

      mcpConfigSection = `echo -e "\\n📦 Installing MCP servers"
# Configure built-in MCPs
rover-agent config mcp $AGENT package-manager --transport "http" http://127.0.0.1:8090/mcp

# Configure MCPs from rover.json if mcps array exists
#
# TODO(ereslibre): replace with \`rover-agent config mcps\` that by
# default will read /workspace/rover.json.
configure_all_mcps() {
  # Fail as soon as the configuration of one of the provided MCP's
  # fail. This is because results might not be close to what the user
  # expects without the required MCP's.

  set -e
  trap 'warn_mcp_configuration_failed; return 1' ERR

  ${configureAllMCPCommands.join('\n  ')}

  trap - ERR
  set +e
}

warn_mcp_configuration_failed() {
  echo "❌ Failed to configure MCP servers"
  safe_exit 1
}

configure_all_mcps

echo -e "\\n📦 Done installing MCP servers"`;
    }

    // --- initScript execution ---
    let initScriptExecution = '';
    const allInitScripts = this.projectConfig.allInitScripts;
    const executableInitScripts = allInitScripts.flatMap((entry, index) =>
      useCachedImage && !entry.path
        ? []
        : !entry.path || this.isSafeWorkspacePath(entry.path)
          ? [{ entry, index }]
          : []
    );
    if (executableInitScripts.length > 0) {
      const scriptBlocks: string[] = [];
      for (const { entry, index } of executableInitScripts) {
        const label = entry.path ? ` (${entry.path})` : '';
        if (entry.path) {
          scriptBlocks.push(`echo "🔧 Running initialization script${label}"
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
chmod +x "$workspace_script_${index}"
cd "$workspace_dir_${index}"
bash "$workspace_script_${index}"
if [ $? -eq 0 ]; then
  echo "✅ Initialization script${label} completed successfully"
else
  echo "❌ Initialization script${label} failed"
  safe_exit 1
fi
cd /workspace`);
          continue;
        }

        const escapedMountedScript = shellEscape(
          getRootInitScriptMountPath(allInitScripts, index)
        );
        const escapedWorkspaceScript = shellEscape(
          `/workspace/${entry.script}`
        );
        scriptBlocks.push(`echo "🔧 Running initialization script${label}"
mounted_script_${index}=${escapedMountedScript}
workspace_script_${index}=${escapedWorkspaceScript}
if [ -f "$mounted_script_${index}" ]; then
  root_script_${index}="$mounted_script_${index}"
elif [ -f "$workspace_script_${index}" ]; then
  root_script_${index}="$workspace_script_${index}"
else
  echo "❌ Initialization script${label} not found at $mounted_script_${index} or $workspace_script_${index}"
  safe_exit 1
fi
chmod +x "$root_script_${index}"
bash "$root_script_${index}"
if [ $? -eq 0 ]; then
  echo "✅ Initialization script${label} completed successfully"
else
  echo "❌ Initialization script${label} failed"
  safe_exit 1
fi`);
      }
      initScriptExecution = `
echo -e "\\n======================================="
echo "🔧 Running initialization scripts"
echo "======================================="
${scriptBlocks.join('\n')}
`;
    }

    // --- external project repositories ---
    let projectRepositoriesSection = '';
    const projectsWithRepositories = this.workspaceProjects.filter(
      project => project.repository
    );

    if (projectsWithRepositories.length > 0) {
      const taskBranch = this.task.branchName || `task/${this.task.id}`;
      const escapedTaskBranch = shellEscape(taskBranch);
      const repositoryStateFunctions = `
compute_repo_untracked_hash() {
  local repo_path="$1"
  node - "$repo_path" <<'NODE'
const { createHash } = require('crypto');
const { existsSync, lstatSync, readFileSync, readlinkSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const repoPath = process.argv[2];
const result = spawnSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '-z'],
  { cwd: repoPath, encoding: 'utf8' }
);
const entries = (result.stdout || '')
  .split('\\0')
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

const hash = createHash('sha256');
for (const relativePath of entries) {
  const fullPath = join(repoPath, relativePath);
  hash.update(relativePath);
  hash.update('\\0');

  if (!existsSync(fullPath)) {
    hash.update('missing\\0');
    continue;
  }

  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    hash.update('symlink\\0');
    hash.update(readlinkSync(fullPath));
    hash.update('\\0');
    continue;
  }

  if (stat.isFile()) {
    hash.update('file\\0');
    hash.update(readFileSync(fullPath));
    hash.update('\\0');
    continue;
  }

  if (stat.isDirectory()) {
    hash.update('dir\\0');
    continue;
  }

  hash.update('other\\0');
}

process.stdout.write(hash.digest('hex'));
NODE
}

compute_repo_tracked_diff_hash() {
  local repo_path="$1"
  node - "$repo_path" <<'NODE'
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const repoPath = process.argv[2];
const result = spawnSync(
  'git',
  ['diff', '--binary', 'HEAD', '--no-ext-diff'],
  { cwd: repoPath, encoding: 'utf8' }
);

process.stdout.write(
  createHash('sha256').update((result.stdout || '').trimEnd()).digest('hex')
);
NODE
}
`;

      const syncBlocks = projectsWithRepositories.map(project => {
        const targetPath = `/workspace/${project.path}`;
        const escapedName = shellEscape(project.name);
        const escapedPath = shellEscape(targetPath);
        const escapedRepository = shellEscape(
          project.runtimeRepository ?? project.repository!
        );
        const escapedRef = project.ref ? shellEscape(project.ref) : '';
        const checkpointLookupScript = shellEscape(
          `const fs=require('fs'); const checkpoint=JSON.parse(fs.readFileSync('/output/checkpoint.json','utf8')); const entry=(checkpoint.externalRepositories||[]).find(repo => repo.path === ${JSON.stringify(project.path)}); if (!entry) process.exit(2); process.stdout.write([entry.head, entry.trackedDiffHash, entry.untrackedHash].join('\\t'));`
        );

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
fi`
          : `
default_remote_ref=$(git -C ${escapedPath} symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -z "$default_remote_ref" ]; then
  echo "❌ Could not determine default remote branch for ${escapedName}"
  safe_exit 1
fi
default_branch="\${default_remote_ref#origin/}"
echo "🔀 Checking out default branch $default_branch for ${escapedName}"
git -C ${escapedPath} checkout -B "$default_branch" "$default_remote_ref"`;

        if (this.resumeFromCheckpoint) {
          return `echo "📥 Verifying repository ${escapedName} for checkpoint resume"
if [ ! -d ${escapedPath}/.git ]; then
  echo "❌ Repository ${escapedName} is missing at ${escapedPath}; cannot resume from checkpoint safely"
  safe_exit 1
fi
current_origin=$(git -C ${escapedPath} remote get-url origin 2>/dev/null || true)
if [ "$current_origin" != ${escapedRepository} ]; then
  echo "❌ Existing repository at ${escapedPath} points to a different origin"
  safe_exit 1
fi
if [ ! -f /output/checkpoint.json ]; then
  echo "❌ Checkpoint file is missing; cannot resume ${escapedName} safely"
  safe_exit 1
fi
if ! expected_state=$(node -e ${checkpointLookupScript}); then
  echo "❌ Checkpoint is missing repository state for ${escapedName}; cannot resume safely"
  safe_exit 1
fi
IFS=$'\\t' read -r expected_head expected_tracked_diff_hash expected_untracked_hash <<< "$expected_state"
current_head=$(git -C ${escapedPath} rev-parse HEAD)
current_tracked_diff_hash=$(compute_repo_tracked_diff_hash ${escapedPath})
current_untracked_hash=$(compute_repo_untracked_hash ${escapedPath})
if [ "$current_head" != "$expected_head" ] || [ "$current_tracked_diff_hash" != "$expected_tracked_diff_hash" ] || [ "$current_untracked_hash" != "$expected_untracked_hash" ]; then
  echo "❌ Repository ${escapedName} no longer matches the checkpointed revision"
  safe_exit 1
fi
echo "✅ Repository ${escapedName} is ready for checkpoint resume"`;
        }

        return `echo "📥 Syncing repository ${escapedName}"
mkdir -p "$(dirname ${escapedPath})"
if [ ! -d ${escapedPath}/.git ]; then
  rm -rf ${escapedPath}
  if ! git clone ${escapedRepository} ${escapedPath}; then
    echo "❌ Failed to clone repository ${escapedName}"
    safe_exit 1
  fi
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
if git -C ${escapedPath} rev-parse --verify refs/remotes/origin/${escapedTaskBranch} >/dev/null 2>&1; then
  echo "🌿 Checking out task branch ${escapedTaskBranch} for ${escapedName} from origin"
  git -C ${escapedPath} checkout -B ${escapedTaskBranch} refs/remotes/origin/${escapedTaskBranch}
elif git -C ${escapedPath} rev-parse --verify refs/heads/${escapedTaskBranch} >/dev/null 2>&1; then
  echo "🌿 Reusing local task branch ${escapedTaskBranch} for ${escapedName}"
  git -C ${escapedPath} checkout ${escapedTaskBranch}
else
  echo "🌿 Creating task branch ${escapedTaskBranch} for ${escapedName}"
  git -C ${escapedPath} checkout -B ${escapedTaskBranch} HEAD
fi
git -C ${escapedPath} reset --hard HEAD
# Remove ignored files too so restarted tasks do not inherit stale child-repo
# build outputs, caches, or generated artifacts from prior runs.
git -C ${escapedPath} clean -fdx
echo "✅ Repository ${escapedName} is ready"`;
      });

      projectRepositoriesSection = `
echo -e "\\n======================================="
echo "${this.resumeFromCheckpoint ? '📥 Verifying external repositories for checkpoint resume' : '📥 Syncing external repositories'}"
echo "======================================="
${repositoryStateFunctions}
${syncBlocks.join('\n')}
`;
    }

    // --- sudoers removal ---
    // Only needed on the first (non-cached) run. The committed image already
    // has this file removed, so the cached image only has the base-image
    // sudoers profile with restricted permissions.
    const sudoersRemoval = useCachedImage
      ? ''
      : `# Remove ourselves from sudoers
echo -e "\\n👤 Removing privileges after completing the setup!"
sudo rm -f /etc/sudoers.d/1-agent-setup`;

    // Generate network filtering configuration (always runs — iptables are runtime state)
    const effectiveNetworkConfig = mergeNetworkConfig(
      this.projectConfig.network,
      this.task.networkConfig
    );
    const networkConfigSection = generateNetworkScript(effectiveNetworkConfig, {
      serviceHostnames: (this.projectConfig.services ?? []).map(
        service => service.name
      ),
    });

    // Generate template variables for task-related sections
    const validateTaskFileFunction = includeTaskSetup
      ? `
# Function to validate task description file
validate_task_file() {
    if [ ! -f "/task/description.json" ]; then
        echo "❌ Task description file not found at /task/description.json"
        safe_exit 1
    fi
}
`
      : '';

    const validateTaskFileCall = includeTaskSetup
      ? `
# Validate task description file
validate_task_file`
      : '';

    const taskDataSection = includeTaskSetup
      ? `
# Read task data from mounted JSON file
TASK_ID=$(jq -r '.id' /task/description.json)
TASK_ITERATION=$(jq -r '.iteration' /task/description.json)
TASK_TITLE=$(jq -r '.title' /task/description.json)
TASK_DESCRIPTION=$(jq -r '.description' /task/description.json)

echo -e "\\n======================================="
echo "🚀 Rover Task Execution Setup"
echo "======================================="
echo "Task Title: $TASK_TITLE"
echo "Task ID: $TASK_ID"
echo "Task Iteration: $TASK_ITERATION"
echo "======================================="
`
      : '';

    const exportTaskVariables = includeTaskSetup
      ? `
# Export variables for agent execution
export TASK_ID TASK_TITLE TASK_DESCRIPTION
`
      : '';

    const workflowExecutionSection = includeTaskSetup
      ? `
# Execute the complete task workflow
echo -e "\\n======================================="
echo "🚀 Running Workflow"
echo "======================================="
`
      : '';

    // Generate script content
    const scriptContent = pupa(entrypointScript, {
      agent: this.agent,
      recoverPermissions,
      aptGetUpdate,
      homeSetup,
      gitSafeDirectorySetup,
      installAllPackages,
      workspaceDeps,
      agentInstallSection,
      credentialInstallSection,
      mcpConfigSection,
      projectRepositoriesSection,
      initScriptExecution,
      sudoersRemoval,
      networkConfigSection,
      validateTaskFileFunction,
      validateTaskFileCall,
      taskDataSection,
      exportTaskVariables,
      workflowExecutionSection,
    });

    // Write script to file
    const scriptPath = join(this.iterationPath, entrypointFilename);
    writeFileSync(scriptPath, scriptContent.replace(/\r\n/g, '\n'), 'utf8');

    // Make script executable
    chmodSync(scriptPath, 0o755);

    return scriptPath;
  }

  /**
   * Generate the inputs file to store task inputs and simplify loading them.
   */
  generateInputs(): string {
    // Use the current iteration's expanded title/description when available,
    // falling back to the original task-level values for the first iteration.
    const currentIteration = this.task.getLastIteration();
    const inputs: Record<string, string> = {
      // Start with all user-provided workflow inputs stored in the task
      ...this.task.inputs,
      // Always override title/description with the expanded versions
      title: currentIteration?.title ?? this.task.title,
      description: currentIteration?.description ?? this.task.description,
    };

    const inputsPath = join(this.iterationPath, 'inputs.json');
    writeFileSync(inputsPath, JSON.stringify(inputs, null, 2), 'utf-8');

    return inputsPath;
  }

  /**
   * Generate a workspace description JSON file when projects are defined.
   * Returns the file path, or undefined if no projects are configured.
   */
  generateWorkspaceDescription(): string | undefined {
    const projects = this.workspaceProjects;
    if (!projects || projects.length === 0) {
      return undefined;
    }

    const description = {
      projects: projects.map(p => ({
        name: p.name,
        path: p.path,
        repository: p.repository,
        ref: p.ref,
        languages: p.languages || [],
        packageManagers: p.packageManagers || [],
      })),
    };

    const filePath = join(this.iterationPath, 'workspace-description.json');
    writeFileSync(filePath, JSON.stringify(description, null, 2), 'utf-8');

    return filePath;
  }

  getRepositoryMounts(): Array<{ hostPath: string; containerPath: string }> {
    return [...this.repositoryMounts];
  }

  /**
   * Save the workflow file into the target task.
   */
  saveWorkflow(workflowName: string): string {
    // Write workflow file to task base path (workflow cannot change between iterations)
    const workflowTaskPath = join(this.taskBasePath, 'workflow.yml');
    const workflowStore = initWorkflowStore(this.projectConfig.projectRoot);
    const workflow = workflowStore.getWorkflow(workflowName);

    if (!workflow) {
      throw new Error(`Workflow '${workflowName}' not found`);
    }

    cpSync(workflow.filePath, workflowTaskPath);

    return workflowTaskPath;
  }

  /**
   * Generate pre-context files with task and iteration information
   * These files are used by the agent to inject context into the workflow
   * Returns an array of file paths
   */
  generatePreContextFiles(): string[] {
    const iterationsPath = this.task.iterationsPath();
    const currentIteration = this.task.iterations;

    // Get initial task info from iteration 1
    let initialTask = {
      title: this.task.title,
      description: this.task.description,
    };

    const firstIterationPath = join(iterationsPath, '1');
    if (existsSync(firstIterationPath)) {
      try {
        const firstIteration = IterationManager.load(firstIterationPath);
        initialTask = {
          title: firstIteration.title,
          description: firstIteration.description,
        };
      } catch (error) {
        // If we can't load iteration 1, use task description as fallback
        if (VERBOSE) {
          console.error('Failed to load iteration 1 for pre-context:', error);
        }
      }
    }

    // Gather previous iterations (only first and last before current)
    const previousIterations: PreviousIteration[] = [];

    // Only include iterations if there are at least 2 iterations before current
    if (currentIteration > 1) {
      // Always include iteration 1 if it's not the current iteration
      if (currentIteration > 2) {
        const firstIterPath = join(iterationsPath, '1');
        if (existsSync(firstIterPath)) {
          try {
            const iteration = IterationManager.load(firstIterPath);
            const markdownFiles = iteration.getMarkdownFiles();

            previousIterations.push({
              number: 1,
              title: iteration.title,
              description: iteration.description,
              changes: markdownFiles.get('changes.md') || undefined,
            });
          } catch (error) {
            // Skip if can't be loaded
            if (VERBOSE) {
              console.error(
                `Failed to load iteration 1 for pre-context:`,
                error
              );
            }
          }
        }
      }

      // Always include the previous iteration (the one right before current)
      const prevIterNum = currentIteration - 1;
      const prevIterPath = join(iterationsPath, prevIterNum.toString());
      if (existsSync(prevIterPath)) {
        try {
          const iteration = IterationManager.load(prevIterPath);
          const markdownFiles = iteration.getMarkdownFiles();

          previousIterations.push({
            number: prevIterNum,
            title: iteration.title,
            description: iteration.description,
            changes: markdownFiles.get('changes.md') || undefined,
          });
        } catch (error) {
          // Skip if can't be loaded
          if (VERBOSE) {
            console.error(
              `Failed to load iteration ${prevIterNum} for pre-context:`,
              error
            );
          }
        }
      }
    }

    // Load current iteration data
    let currentIterationData: PreviousIteration | undefined = undefined;
    const currentIterPath = join(iterationsPath, currentIteration.toString());
    if (existsSync(currentIterPath)) {
      try {
        const iteration = IterationManager.load(currentIterPath);
        const markdownFiles = iteration.getMarkdownFiles();

        currentIterationData = {
          number: currentIteration,
          title: iteration.title,
          description: iteration.description,
          changes: markdownFiles.get('changes.md') || undefined,
        };
      } catch (error) {
        // If we can't load current iteration, continue without it
        if (VERBOSE) {
          console.error(
            `Failed to load current iteration ${currentIteration} for pre-context:`,
            error
          );
        }
      }
    }

    // Build pre-context data using PreContextDataManager
    const preContextManager = PreContextDataManager.create(
      this.iterationPath,
      this.task.id.toString(),
      initialTask,
      previousIterations.length > 0 ? previousIterations : undefined,
      currentIterationData
    );

    // Return array with the single pre-context file
    // This allows for future expansion to support multiple files
    const preContextPath = join(this.iterationPath, '__pre_context__.json');
    return [preContextPath];
  }

  /**
   * Get the path for an iteration-specific script file
   */
  getScriptPath(script: string): string {
    return join(this.iterationPath, script);
  }

  /**
   * Get the path for a task-level file (not iteration-specific)
   */
  getTaskFilePath(filename: string): string {
    return join(this.taskBasePath, filename);
  }

  /**
   * Static factory method to create and generate setup script
   */
  static generate(
    taskDescription: TaskDescriptionManager,
    agent: string,
    projectPath: string
  ): string {
    const projectConfig = ProjectConfigManager.load(projectPath);
    const builder = new SetupBuilder(taskDescription, agent, projectConfig);
    return builder.generateEntrypoint();
  }
}
