import colors from 'ansi-colors';
import { showProperties, showList } from 'rover-core';
import { CommandOutput } from '../cli.js';
import { createAgent } from '../lib/agents/index.js';

interface InstallCommandOptions {
  // Specific version to install
  version: string;
}

interface InstallCommandOutput extends CommandOutput {}

// Default agent version to install
export const DEFAULT_INSTALL_VERSION = 'latest';

/**
 * Install an AI Coding Tool and configure the required credentials to run it
 */
export const installCommand = async (
  agentName: string,
  options: InstallCommandOptions = {
    version: DEFAULT_INSTALL_VERSION,
  }
) => {
  const output: InstallCommandOutput = {
    success: false,
  };

  try {
    console.log(colors.bold('Agent Installation'));
    showProperties({
      Agent: colors.cyan(agentName),
      Version: colors.cyan(options.version),
    });

    // Create agent instance
    const agent = createAgent(agentName, options.version);

    console.log(colors.bold('\nValidating Credentials'));

    // Validate agent credentials
    const validation = agent.validateCredentials();

    if (!validation.valid) {
      console.log(colors.yellow('\n⚠ Some credential files are missing'));
      showList(
        validation.missing.map(missing => colors.yellow(`Missing: ${missing}`))
      );

      console.log(
        colors.yellow(
          '\n💡 Credentials may be provided via environment variables or proxy configuration.'
        )
      );
      throw new Error('Required credential files are missing');
    } else {
      console.log(colors.green('✓ All required credential files found'));
    }

    // Install only after credential validation succeeds so a failed setup does
    // not mutate the host with a partially configured CLI.
    await agent.install();

    // Copy credentials to the user's home directory (best-effort)
    await agent.copyCredentials(process.env.HOME || '/home/agent');

    console.log(colors.green('\n✓ Installation completed successfully'));
    output.success = true;
  } catch (err) {
    output.success = false;
    output.error = err instanceof Error ? err.message : `${err}`;
  }

  if (!output.success) {
    console.log(colors.red(`\n✗ ${output.error}`));
    process.exitCode = 1;
  }
};
