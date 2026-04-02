import type { CommandDefinition } from '../../types.js';
import { isJsonMode } from '../../lib/context.js';
import { setRtkEnabledByDefault } from '../../lib/rtk.js';

export const disableRtkCommand = async (): Promise<void> => {
  const config = setRtkEnabledByDefault(false);

  if (isJsonMode()) {
    console.log(JSON.stringify({ success: true, enabled: config.enabled }, null, 2));
    return;
  }

  console.log('RTK disabled by default for rover tasks.');
};

export default {
  name: 'disable',
  parent: 'rtk',
  description: 'Disable RTK by default for rover tasks',
  requireProject: false,
  action: disableRtkCommand,
} satisfies CommandDefinition;
