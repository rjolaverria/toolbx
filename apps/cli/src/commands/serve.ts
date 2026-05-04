import { Command, Option } from '@commander-js/extra-typings';
import {
  createLogger,
  loadConfig,
  resolveConfigPath,
  type CreateLoggerOptions,
  type LogFormat,
  type LogLevel,
  type ToolBoxConfig,
} from '@toolbox/core';
import {
  createDownstreamHttpServer,
  createDownstreamStdioServer,
  createGatewayRuntime,
  type CreateDownstreamHttpServerDeps,
  type CreateDownstreamStdioServerDeps,
  type DownstreamHttpServer,
  type DownstreamStdioServer,
  type GatewayRuntime,
} from '@toolbox/mcp-gateway';

const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
] as const satisfies readonly LogLevel[];
const LOG_FORMATS = ['pretty', 'json'] as const satisfies readonly LogFormat[];

export interface ServeOptions {
  stdio?: boolean;
  http?: boolean;
  config?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
}

export type ServeMode = 'stdio' | 'http';

export interface ServeStartedInfo {
  readonly mode: ServeMode;
  readonly url?: URL;
  readonly runtime: GatewayRuntime;
}

export interface ServeDeps {
  resolvePath: () => string;
  loadConfig: (path: string) => Promise<ToolBoxConfig>;
  createLogger: (options: CreateLoggerOptions) => ReturnType<typeof createLogger>;
  createRuntime: typeof createGatewayRuntime;
  createStdio: (deps: CreateDownstreamStdioServerDeps) => DownstreamStdioServer;
  createHttp: (deps: CreateDownstreamHttpServerDeps) => DownstreamHttpServer;
  stderr: (msg: string) => void;
  processEnv: NodeJS.ProcessEnv;
  /**
   * Optional callback fired once the downstream server is listening and the
   * runtime has kicked off upstream connect attempts. Tests use this to
   * capture the bound HTTP URL and drive a real MCP client round-trip
   * before tearing the server down.
   */
  onStarted?: (info: ServeStartedInfo) => void;
  /**
   * Process used by the downstream servers to attach SIGINT/SIGTERM
   * handlers. Production passes the real `process`; tests inject a fake
   * EventEmitter so they can simulate signal-driven shutdown without
   * touching the test runner's process.
   */
  signalProcess?: NodeJS.Process;
}

export function defaultServeDeps(): ServeDeps {
  return {
    resolvePath: () => resolveConfigPath(),
    loadConfig: (path) => loadConfig(path),
    createLogger: (options) => createLogger(options),
    createRuntime: createGatewayRuntime,
    createStdio: createDownstreamStdioServer,
    createHttp: createDownstreamHttpServer,
    stderr: (msg) => {
      process.stderr.write(msg);
    },
    processEnv: process.env,
    signalProcess: process,
  };
}

export async function runServe(options: ServeOptions, deps: ServeDeps): Promise<number> {
  if (options.stdio === true && options.http === true) {
    deps.stderr('tlbx serve: --stdio and --http are mutually exclusive\n');
    return 2;
  }
  const mode: ServeMode = options.stdio === true ? 'stdio' : 'http';

  const configPath =
    options.config !== undefined && options.config.length > 0 ? options.config : deps.resolvePath();

  let config: ToolBoxConfig;
  try {
    config = await deps.loadConfig(configPath);
  } catch (error) {
    deps.stderr(`tlbx serve: failed to load config from ${configPath}: ${errorMessage(error)}\n`);
    return 1;
  }

  if (mode === 'http' && !config.server.http.enabled) {
    deps.stderr(
      'tlbx serve: --http requested but server.http.enabled is false in config; enable it first or run with --stdio\n',
    );
    return 1;
  }

  // stdio mode reserves stdout exclusively for MCP traffic. Logs go to
  // stderr, and we default to JSON so Claude Desktop's log capture stays
  // machine-parseable. HTTP mode is happy to honour the logger's TTY-aware
  // pretty default unless the user picks a format explicitly.
  const loggerOptions: CreateLoggerOptions = {
    level: options.logLevel ?? 'info',
    destination: 'stderr',
    ...(options.logFormat !== undefined
      ? { format: options.logFormat }
      : mode === 'stdio'
        ? { format: 'json' }
        : {}),
  };
  const logger = deps.createLogger(loggerOptions);

  const runtime = deps.createRuntime({
    config,
    logger,
    processEnv: deps.processEnv,
  });
  runtime.startUpstreams();

  if (mode === 'stdio') {
    const downstream = deps.createStdio({
      logger,
      registerHandlers: runtime.registerHandlers,
      ...(deps.signalProcess !== undefined ? { process: deps.signalProcess } : {}),
    });
    try {
      await downstream.start();
    } catch (error) {
      await runtime.dispose();
      deps.stderr(`tlbx serve: failed to start stdio server: ${errorMessage(error)}\n`);
      return 1;
    }
    deps.onStarted?.({ mode, runtime });
    await downstream.done;
    await runtime.dispose();
    return 0;
  }

  const downstream = deps.createHttp({
    logger,
    http: {
      host: config.server.http.host,
      port: config.server.http.port,
      path: config.server.http.path,
    },
    registerHandlers: runtime.registerHandlers,
    ...(deps.signalProcess !== undefined ? { process: deps.signalProcess } : {}),
  });
  try {
    await downstream.start();
  } catch (error) {
    await runtime.dispose();
    deps.stderr(`tlbx serve: failed to start http server: ${errorMessage(error)}\n`);
    return 1;
  }
  deps.onStarted?.({ mode, url: downstream.url, runtime });
  await downstream.done;
  await runtime.dispose();
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serveCommand(): Command {
  const cmd = new Command('serve')
    .description('Start the ToolBox MCP gateway in stdio or HTTP mode.')
    .option('-s, --stdio', 'serve over stdio')
    .option('-H, --http', 'serve over Streamable HTTP using config.server.http (default)')
    .option('-c, --config <path>', 'override the resolved config path for this run')
    .addOption(new Option('-l, --log-level <level>', 'logger verbosity').choices(LOG_LEVELS))
    .addOption(new Option('--log-format <format>', 'logger output format').choices(LOG_FORMATS))
    .action(async (opts) => {
      const code = await runServe(opts, defaultServeDeps());
      if (code !== 0) {
        process.exit(code);
      }
    });
  return cmd;
}
