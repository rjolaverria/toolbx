import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { toolsListCommand } from './tools-list.js';
import { toolsSearchCommand } from './tools-search.js';
import { toolsDisableCommand, toolsEnableCommand } from './tools-toggle.js';

export function toolsCommand(): CommandUnknownOpts {
  const cmd = new Command('tools').description(
    'Browse and gate the tools Toolbx exposes through the gateway.',
  );
  cmd.addCommand(toolsListCommand());
  cmd.addCommand(toolsSearchCommand());
  cmd.addCommand(toolsEnableCommand());
  cmd.addCommand(toolsDisableCommand());
  return cmd;
}
