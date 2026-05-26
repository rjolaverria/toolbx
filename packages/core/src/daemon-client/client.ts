import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { getToolBoxVersion } from '../version.js';
import { CONTROL_PLANE_HEADER, CONTROL_PLANE_MARKER } from '../serve-daemon/control-plane.js';

/** Result of `tools/list` against the daemon (the SDK's `ListToolsResult`). */
export type DaemonListToolsResult = Awaited<ReturnType<Client['listTools']>>;
/** Parameters and result of `tools/call` against the daemon. */
export type DaemonCallToolParams = Parameters<Client['callTool']>[0];
export type DaemonCallToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * The slice of the MCP `Client` API `tlbx run` needs from the daemon. The real
 * SDK `Client` satisfies this; tests inject a fake.
 */
export interface DaemonMcpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<DaemonListToolsResult>;
  callTool(params: DaemonCallToolParams): Promise<DaemonCallToolResult>;
  close(): Promise<void>;
}

/** A connected daemon session scoped to a single `tlbx run` invocation. */
export interface DaemonClient {
  listTools(): Promise<DaemonListToolsResult>;
  callTool(params: DaemonCallToolParams): Promise<DaemonCallToolResult>;
  close(): Promise<void>;
}

export interface ConnectDaemonClientDeps {
  /**
   * Builds the MCP transport for `url`, attaching `headers`. The default wires
   * a Streamable HTTP transport; the control-plane marker is passed here so the
   * daemon exempts this session from progressive disclosure (SPECS §5.3).
   */
  buildTransport: (url: URL, headers: Record<string, string>) => unknown;
  /** Builds the MCP client. Defaults to the SDK `Client`. */
  buildClient: () => DaemonMcpClient;
}

const DAEMON_CLIENT_INFO = { name: 'tlbx-run', version: getToolBoxVersion() } as const;

export function defaultConnectDaemonClientDeps(): ConnectDaemonClientDeps {
  return {
    buildTransport: (url, headers) =>
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    buildClient: () => new Client(DAEMON_CLIENT_INFO, { capabilities: {} }),
  };
}

/**
 * Connects to a ToolBox daemon's loopback Streamable HTTP MCP endpoint as a
 * local control-plane caller (SPECS §5.3). The connection carries the
 * control-plane marker so progressive disclosure does not gate `tlbx run`:
 * every enabled tool is callable by name regardless of the revealed set.
 *
 * On a failed handshake the client is closed before the error propagates so a
 * half-open transport is never leaked.
 */
export async function connectDaemonClient(
  url: string,
  deps: ConnectDaemonClientDeps = defaultConnectDaemonClientDeps(),
): Promise<DaemonClient> {
  const transport = deps.buildTransport(new URL(url), {
    [CONTROL_PLANE_HEADER]: CONTROL_PLANE_MARKER,
  });
  const client = deps.buildClient();
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await client.close();
    } catch {
      // best effort — the connect error is the meaningful one
    }
    throw error;
  }
  return {
    listTools: () => client.listTools(),
    callTool: (params) => client.callTool(params),
    close: () => client.close(),
  };
}
