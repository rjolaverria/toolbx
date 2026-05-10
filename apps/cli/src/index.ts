#!/usr/bin/env node

import { Command } from '@commander-js/extra-typings';

import { clientCommand } from './commands/client-print-config.js';
import { configCommand } from './commands/config.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { serveCommand } from './commands/serve.js';
import { serverCommand } from './commands/server.js';
import { statusCommand } from './commands/status.js';
import { toolsCommand } from './commands/tools.js';

async function main(): Promise<void> {
  const program = new Command()
    .name('tlbx')
    .description('ToolBox — local MCP gateway and proxy')
    .version('0.0.0');

  program.addCommand(initCommand());
  program.addCommand(serverCommand());
  program.addCommand(serveCommand());
  program.addCommand(statusCommand());
  program.addCommand(toolsCommand());
  program.addCommand(clientCommand());
  program.addCommand(configCommand());
  program.addCommand(doctorCommand());

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`tlbx: ${message}\n`);
  process.exit(1);
});
