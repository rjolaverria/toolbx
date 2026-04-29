#!/usr/bin/env node

import { Command } from '@commander-js/extra-typings';

import { initCommand } from './commands/init.js';

async function main(): Promise<void> {
  const program = new Command()
    .name('tlbx')
    .description('Toolbox — local MCP gateway and proxy')
    .version('0.0.0');

  program.addCommand(initCommand());

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`tlbx: ${message}\n`);
  process.exit(1);
});
