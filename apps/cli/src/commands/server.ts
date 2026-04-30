import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { addHttpCommand, addStdioCommand } from './server-add.js';
import { editCommand } from './server-edit.js';
import { inspectCommand } from './server-inspect.js';
import { listCommand } from './server-list.js';
import { removeCommand } from './server-remove.js';
import { statusCommand } from './server-status.js';
import { disableCommand, enableCommand } from './server-toggle.js';

export function serverCommand(): CommandUnknownOpts {
  const cmd = new Command('server').description(
    'Manage upstream MCP servers in the Toolbox config.',
  );
  cmd.addCommand(addStdioCommand());
  cmd.addCommand(addHttpCommand());
  cmd.addCommand(listCommand());
  cmd.addCommand(statusCommand());
  cmd.addCommand(enableCommand());
  cmd.addCommand(disableCommand());
  cmd.addCommand(removeCommand());
  cmd.addCommand(editCommand());
  cmd.addCommand(inspectCommand());
  return cmd;
}
