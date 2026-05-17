export type ClientName = 'claude' | 'codex' | 'opencode';

export interface DetectedClient {
  readonly name: ClientName;
  readonly configPath: string;
}

export interface InstallOpts {
  readonly dryRun: boolean;
  readonly force: boolean;
}

export type InstallResult =
  | {
      ok: true;
      status: 'installed' | 'already-installed';
      configPath: string;
      backupPath?: string;
      diff: string;
    }
  | { ok: false; reason: string; hint?: string };

export interface ClientAdapter {
  readonly name: ClientName;
  detect(): Promise<DetectedClient | null>;
  install(opts: InstallOpts): Promise<InstallResult>;
}

export interface ClientAdapterEnv {
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}
