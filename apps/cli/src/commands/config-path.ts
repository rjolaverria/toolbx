import { Command, type CommandUnknownOpts } from '@commander-js/extra-typings';
import {
  describeConfigPath,
  type ConfigPathSource,
  type ResolvedConfigPath,
} from '@rjolaverria/toolbox-core';

export interface ConfigPathOptions {
  json?: true;
}

export interface ConfigPathDeps {
  describe: () => ResolvedConfigPath;
  stdout: (msg: string) => void;
}

export function defaultConfigPathDeps(): ConfigPathDeps {
  return {
    describe: () => describeConfigPath(),
    stdout: (msg) => {
      process.stdout.write(msg);
    },
  };
}

const SOURCE_DESCRIPTIONS: Record<ConfigPathSource, string> = {
  'env-toolbox-config': 'TOOLBOX_CONFIG environment variable',
  'env-xdg-config-home': 'XDG_CONFIG_HOME environment variable',
  'env-appdata': 'APPDATA environment variable',
  'home-windows': 'Windows home directory default',
  'home-posix': 'POSIX home directory default',
};

export function describeSource(source: ConfigPathSource): string {
  return SOURCE_DESCRIPTIONS[source];
}

export function runConfigPath(options: ConfigPathOptions, deps: ConfigPathDeps): number {
  const resolved = deps.describe();
  if (options.json === true) {
    deps.stdout(
      `${JSON.stringify(
        {
          path: resolved.path,
          source: resolved.source,
          sourceDescription: describeSource(resolved.source),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  deps.stdout(`${resolved.path}\n`);
  deps.stdout(`source: ${describeSource(resolved.source)}\n`);
  return 0;
}

export function configPathCommand(): CommandUnknownOpts {
  return new Command('path')
    .description('Print the resolved ToolBox config path and which precedence rule produced it.')
    .option('--json', 'emit machine-readable JSON')
    .action((opts) => {
      const code = runConfigPath(opts, defaultConfigPathDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
}
