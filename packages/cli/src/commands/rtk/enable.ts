import type { CommandDefinition } from '../../types.js';
import { isJsonMode } from '../../lib/context.js';
import { setRtkEnabledByDefault } from '../../lib/rtk.js';

export const enableRtkCommand = async (): Promise<void> => {
  const config = setRtkEnabledByDefault(true);

  if (isJsonMode()) {
    console.log(JSON.stringify({ success: true, enabled: config.enabled }, null, 2));
    return;
  }

  console.log('RTK enabled by default for rover tasks.');
};

export default {
  name: 'enable',
  parent: 'rtk',
  description: 'Enable RTK by default for rover tasks',
  requireProject: false,
  action: enableRtkCommand,
} satisfies CommandDefinition;
