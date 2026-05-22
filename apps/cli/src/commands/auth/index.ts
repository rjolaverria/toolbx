import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import { authLoginCommand } from './login.js';
import { authLogoutCommand } from './logout.js';
import { authRefreshCommand } from './refresh.js';
import { authStatusCommand } from './status.js';

export function createAuthCommand(): CommandUnknownOpts {
  const cmd = new Command('auth').description('Manage OAuth credentials for upstream MCP servers.');
  cmd.addCommand(authLoginCommand());
  cmd.addCommand(authLogoutCommand());
  cmd.addCommand(authStatusCommand());
  cmd.addCommand(authRefreshCommand());
  return cmd;
}
