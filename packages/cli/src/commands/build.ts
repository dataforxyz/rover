import colors from 'ansi-colors';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectConfigManager, showProperties, showTitle, launch } from 'rover-core';
import { getProjectPath, isJsonMode } from '../lib/context.js';
import { getAvailableSandboxBackend } from '../lib/sandbox/index.js';
import { ContainerBackend, resolveAgentImage } from '../lib/sandbox/container-common.js';
import {
  checkImageCache,
  waitForInitAndCommit,
} from '../lib/sandbox/container-image-cache.js';
import { exitWithError, exitWithSuccess } from '../utils/exit.js';
import type { CommandDefinition } from '../types.js';
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

function generateBuildEntrypoint(
  agent: string,
  projectConfig: ProjectConfigManager,
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

# Install languages, package managers, task managers
${installScripts.join('\n')}

# Install agent CLI
echo "Installing agent CLI ($AGENT)..."
sudo -E rover-agent install $AGENT || echo "Agent install failed (non-fatal for build)"
sudo chown -R $(id -u):$(id -g) $HOME

# Copy credentials
echo "Copying agent credentials..."
sudo rover-agent-install $AGENT || true
for _cred_dir in $HOME/.codex $HOME/.claude $HOME/.config/github-copilot $HOME/.gemini $HOME/.qwen $HOME/.opencode; do
  [ -d "$_cred_dir" ] && sudo chown -R $(id -u):$(id -g) "$_cred_dir"
done

${mcpSection}

# Make HOME world-writable so the image works with any --user UID:GID.
# The actual task entrypoint does chown, but we set permissive defaults
# so the image is immediately usable (e.g. by verify, shell, etc.)
chmod -R a+rwX $HOME 2>/dev/null || true

# Mark all directories as git-safe so they work with any UID
git config --system --add safe.directory '*' 2>/dev/null || true

echo ""
echo "Build complete!"
exec "$@"
`;
}

const buildCommand = async (
  options: {
    json?: boolean;
    agent?: string;
    force?: boolean;
  } = {}
) => {
  const telemetry = getTelemetry();
  const jsonOutput: Record<string, unknown> = { success: true };

  try {
    const projectPath = getProjectPath() || process.cwd();
    const projectConfig = ProjectConfigManager.load(projectPath);
    const agent = options.agent ?? getUserAIAgent() ?? 'claude';

    if (!isJsonMode()) {
      showTitle('Build Cache Image');
      showProperties({
        'Project': projectPath,
        'Agent': agent,
        'Languages': (projectConfig.allLanguages ?? []).join(', ') || '-',
        'Package managers': (projectConfig.allPackageManagers ?? []).join(', ') || '-',
      });
      console.log();
    }

    // 1. Detect container backend
    const backendName = await getAvailableSandboxBackend();
    if (!backendName) {
      jsonOutput.success = false;
      jsonOutput.error = 'No container backend available. Install Docker or Podman.';
      await exitWithError(jsonOutput, { telemetry });
      return;
    }

    const backend = backendName === 'docker'
      ? ContainerBackend.Docker
      : ContainerBackend.Podman;

    // 2. Resolve agent image
    const agentImage = resolveAgentImage(projectConfig, undefined);

    // 3. Check if cache already exists
    const { hasCachedImage, cacheTag } = checkImageCache(
      backend,
      projectConfig,
      agentImage,
      agent,
    );

    if (hasCachedImage && !options.force) {
      if (!isJsonMode()) {
        console.log(colors.green('Cache image already exists: ') + colors.cyan(cacheTag));
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
    writeFileSync(entrypointPath, generateBuildEntrypoint(agent, projectConfig));
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
      'create', '--name', containerName,
      '-v', `${projectPath}:/workspace:Z,ro`,
      '-v', `${entrypointPath}:/entrypoint.sh:Z,ro`,
      '-w', '/workspace',
      '--entrypoint', '/entrypoint.sh',
    ];

    // Add agent-specific mounts (credential files)
    try {
      const agentTool = getAIAgentTool(agent);
      dockerArgs.push(...agentTool.getContainerMounts());
    } catch {
      // Agent tool not found — skip mounts
    }

    // Add extra args from project config (cache volumes, etc.)
    const configExtraArgs = projectConfig.sandboxExtraArgs ?? [];
    for (const arg of configExtraArgs) {
      dockerArgs.push(arg);
    }

    // Init-only: run entrypoint then exit with 'true'
    dockerArgs.push(agentImage, 'true');

    if (!isJsonMode()) {
      console.log('Creating build container...');
    }

    await launch(backendName, dockerArgs);

    if (!isJsonMode()) {
      console.log('Running setup (installing languages, tools, dependencies)...');
    }

    await launch(backendName, ['start', '-a', containerName]);

    // 7. Wait for init to finish and commit as cache image
    const committed = await waitForInitAndCommit(
      backend,
      containerName,
      cacheTag,
      projectPath,
      agent,
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
        console.log(colors.gray('Future tasks will use this cached image for faster startup.'));
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

export default {
  name: 'build',
  description: 'Build the container cache image for a project',
  requireProject: true,
  action: buildCommand,
} satisfies CommandDefinition;
