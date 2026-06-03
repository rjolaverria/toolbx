import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { toolImportCommand } from './tool-import.js';
import { toolInspectCommand } from './tool-inspect.js';
import { toolListCommand } from './tool-list.js';
import { toolRemoveCommand } from './tool-remove.js';
import { toolDisableCommand, toolEnableCommand } from './tool-toggle.js';

export function toolCommand(): CommandUnknownOpts {
  const cmd = new Command('tool').description('Manage custom local tools imported into ToolBox.');
  cmd.addCommand(toolImportCommand());
  cmd.addCommand(toolListCommand());
  cmd.addCommand(toolInspectCommand());
  cmd.addCommand(toolEnableCommand());
  cmd.addCommand(toolDisableCommand());
  cmd.addCommand(toolRemoveCommand());
  return cmd;
}
