#!/usr/bin/env node

import { createRequire } from 'node:module';

import { Command } from '@commander-js/extra-typings';

import { createAuthCommand } from './commands/auth/index.js';
import { registerClientInstall } from './commands/client-install.js';
import { clientCommand } from './commands/client-print-config.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { serveCommand, serveManagedCommand } from './commands/serve.js';
import { serverCommand } from './commands/server.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { toolCommand } from './commands/tool.js';
import { toolsCommand } from './commands/tools.js';

function resolveVersion(): string {
  // dist/index.js sits one level below the package root, so ../package.json is
  // the installed package manifest (and apps/cli/package.json in dev). Reading it
  // at runtime keeps `tlbx --version` in lockstep with the published version.
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name('tlbx')
    .description('Toolbx — local MCP gateway and proxy')
    .version(resolveVersion());

  program.addCommand(setupCommand());
  program.addCommand(initCommand());
  program.addCommand(serverCommand());
  program.addCommand(serveCommand());
  program.addCommand(serveManagedCommand(), { hidden: true });
  program.addCommand(runCommand());
  program.addCommand(stopCommand());
  program.addCommand(statusCommand());
  program.addCommand(toolCommand());
  program.addCommand(toolsCommand());
  program.addCommand(clientCommand([registerClientInstall]));
  program.addCommand(configCommand());
  program.addCommand(createAuthCommand());
  program.addCommand(doctorCommand());

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`tlbx: ${message}\n`);
  process.exit(1);
});
