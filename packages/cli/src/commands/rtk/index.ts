import { Command } from 'commander';
import disableCmd from './disable.js';
import enableCmd from './enable.js';
import statusCmd from './status.js';

export const addRtkCommands = (program: Command) => {
  const command = program
    .command('rtk')
    .description('Manage RTK defaults for rover task sandboxes');

  command
    .command(statusCmd.name)
    .description(statusCmd.description)
    .option('--json', 'Output the result in JSON format', false)
    .action(statusCmd.action);

  command
    .command(enableCmd.name)
    .description(enableCmd.description)
    .option('--json', 'Output the result in JSON format', false)
    .action(enableCmd.action);

  command
    .command(disableCmd.name)
    .description(disableCmd.description)
    .option('--json', 'Output the result in JSON format', false)
    .action(disableCmd.action);
};
