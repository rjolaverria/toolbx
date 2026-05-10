import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { configEditCommand } from './config-edit.js';
import { configPathCommand } from './config-path.js';
import { configSetCommand } from './config-set.js';
import { configValidateCommand } from './config-validate.js';

export function configCommand(): CommandUnknownOpts {
  const cmd = new Command('config').description(
    'Inspect, edit, validate, and modify the ToolBox config file.',
  );
  cmd.addCommand(configPathCommand());
  cmd.addCommand(configEditCommand());
  cmd.addCommand(configValidateCommand());
  cmd.addCommand(configSetCommand());
  return cmd;
}
