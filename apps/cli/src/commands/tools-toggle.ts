import * as path from 'node:path';

import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';

import {
  readToolCache,
  saveConfig,
  ToolCacheError,
  ToolCacheMissingError,
  withConfigLock,
  type ToolBoxConfig,
} from '@toolbox/core';

import {
  defaultServerCommandDeps,
  loadOrReportMissing,
  resolveTargetPath,
  validateNextConfig,
} from './server-shared.js';
import {
  defaultResolveCachePath,
  parseToolReference,
  ToolReferenceError,
  type ToolsCommandDeps,
} from './tools-shared.js';

export interface ToolsToggleOptions {
  config?: string;
}

async function applyToolToggle(
  reference: string,
  desired: boolean,
  options: ToolsToggleOptions,
  deps: ToolsCommandDeps,
): Promise<number> {
  const target = resolveTargetPath(deps, options.config);
  // The read-modify-write runs under the shared config-dir lock so a concurrent
  // command cannot read the same snapshot and clobber this change (P3-07).
  return withConfigLock(path.dirname(target), async () => {
    const config = await loadOrReportMissing(target, deps);
    if (config === null) {
      return 1;
    }

    let parsed;
    try {
      parsed = parseToolReference(reference, config.namespacing);
    } catch (error) {
      if (error instanceof ToolReferenceError) {
        deps.stderr(`${error.message}\n`);
        return 1;
      }
      throw error;
    }

    if (config.servers[parsed.serverName] === undefined) {
      deps.stderr(
        `Unknown server "${parsed.serverName}" in ${target}; configure it before toggling tools.\n`,
      );
      return 1;
    }

    const cacheCheck = await verifyToolKnown(parsed.exposedName, target, deps);
    if (cacheCheck === 'unknown') {
      deps.stderr(
        `Unknown tool "${reference}". Run \`tlbx tools list\` to see what is available.\n`,
      );
      return 1;
    }
    // 'cache_missing' is non-fatal — we still let the user pre-set an override
    // before the gateway has run. The override is keyed on the exposed name,
    // so when the gateway eventually populates the cache it will pick up the
    // stored preference automatically.

    const current = config.tools[parsed.exposedName];
    if (current?.enabled === desired) {
      deps.stdout(`Tool "${parsed.exposedName}" is already ${desired ? 'enabled' : 'disabled'}.\n`);
      return 0;
    }

    const nextTools: ToolBoxConfig['tools'] = { ...config.tools };
    if (desired) {
      // Default state is "enabled"; clear the override rather than persist a
      // tautology so the config stays minimal.
      delete nextTools[parsed.exposedName];
    } else {
      nextTools[parsed.exposedName] = { enabled: false };
    }
    const candidate: ToolBoxConfig = { ...config, tools: nextTools };
    const validated = validateNextConfig(candidate, target, deps);
    if (!validated.ok) {
      return 1;
    }
    await saveConfig(validated.next, target);
    deps.stdout(`Tool "${parsed.exposedName}" ${desired ? 'enabled' : 'disabled'}.\n`);
    return 0;
  });
}

type CacheCheckResult = 'known' | 'unknown' | 'cache_missing';

async function verifyToolKnown(
  exposedName: string,
  configPath: string,
  deps: ToolsCommandDeps,
): Promise<CacheCheckResult> {
  const cachePath = deps.resolveCachePath(configPath);
  try {
    const cache = await readToolCache(cachePath);
    return cache.tools.some((entry) => entry.exposedName === exposedName) ? 'known' : 'unknown';
  } catch (error) {
    if (error instanceof ToolCacheMissingError) {
      return 'cache_missing';
    }
    if (error instanceof ToolCacheError) {
      // Fail open — corrupted cache shouldn't block the user from editing
      // their config. Surface the error so they can investigate, but treat
      // the tool as known for the purpose of the toggle.
      deps.stderr(`Warning: ${error.message}\n`);
      return 'cache_missing';
    }
    throw error;
  }
}

export function runToolsEnable(
  reference: string,
  options: ToolsToggleOptions,
  deps: ToolsCommandDeps,
): Promise<number> {
  return applyToolToggle(reference, true, options, deps);
}

export function runToolsDisable(
  reference: string,
  options: ToolsToggleOptions,
  deps: ToolsCommandDeps,
): Promise<number> {
  return applyToolToggle(reference, false, options, deps);
}

function defaultDeps(): ToolsCommandDeps {
  return {
    ...defaultServerCommandDeps(),
    resolveCachePath: defaultResolveCachePath,
  };
}

export function toolsEnableCommand(): CommandUnknownOpts {
  return new Command('enable')
    .description('Enable an upstream tool exposed through ToolBox.')
    .argument('<tool>', 'namespace/tool or namespace__tool reference')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (reference, opts) => {
      const code = await runToolsEnable(reference, opts, defaultDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}

export function toolsDisableCommand(): CommandUnknownOpts {
  return new Command('disable')
    .description('Disable an upstream tool from being exposed through ToolBox.')
    .argument('<tool>', 'namespace/tool or namespace__tool reference')
    .option('-c, --config <path>', 'override the resolved config path')
    .action(async (reference, opts) => {
      const code = await runToolsDisable(reference, opts, defaultDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
