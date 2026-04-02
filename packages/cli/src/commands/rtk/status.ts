import type { CommandDefinition } from '../../types.js';
import { isJsonMode } from '../../lib/context.js';
import { getRtkConfigPath, isRtkEnabledByDefault } from '../../lib/rtk.js';

export const rtkStatusCommand = async (): Promise<void> => {
  const enabled = isRtkEnabledByDefault();
  const configPath = getRtkConfigPath();

  if (isJsonMode()) {
    console.log(JSON.stringify({ success: true, enabled, configPath }, null, 2));
    return;
  }

  console.log(`RTK is ${enabled ? 'enabled' : 'disabled'} by default for rover tasks.`);
  console.log(configPath);
};

export default {
  name: 'status',
  parent: 'rtk',
  description: 'Show the default RTK setting for rover tasks',
  requireProject: false,
  action: rtkStatusCommand,
} satisfies CommandDefinition;
