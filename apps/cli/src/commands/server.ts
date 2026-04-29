import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { addHttpCommand, addStdioCommand } from './server-add.js';

export function serverCommand(): CommandUnknownOpts {
  const cmd = new Command('server').description(
    'Manage upstream MCP servers in the Toolbox config.',
  );
  cmd.addCommand(addStdioCommand());
  cmd.addCommand(addHttpCommand());
  return cmd;
}
