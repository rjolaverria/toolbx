import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import type { Logger } from '../logging/logger.js';

export type AuthHint =
  | { kind: 'none' }
  | { kind: 'oauth'; resourceMetadataUrl?: URL }
  | { kind: 'bearer'; realm?: string }
  | { kind: 'unknown'; status: number; body?: string };

export interface ProbeUpstreamAuthDeps {
  logger: Logger;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_EXCERPT = 512;

/**
 * Probe an HTTP MCP endpoint to classify its authentication requirement.
 *
 * Sends a minimal unauthenticated POST `initialize` (the same request the
 * SDK's StreamableHTTPClientTransport sends first) and inspects the response.
 *
 * Never throws on HTTP errors. Network timeouts and transport failures map
 * to `{ kind: 'unknown', status: 0 }` so callers can degrade gracefully.
 */
export async function probeUpstreamAuth(url: URL, deps: ProbeUpstreamAuthDeps): Promise<AuthHint> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'toolbox-probe', version: '0' },
        },
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      // A successful initialize may have opened an MCP HTTP session; tear it
      // down so the probe does not leak server-side session resources.
      const sessionId = res.headers.get('mcp-session-id');
      await discardBody(res);
      if (sessionId) {
        await terminateProbeSession(url, sessionId, fetchFn, controller.signal, deps.logger);
      }
      return { kind: 'none' };
    }

    if (res.status === 401) {
      const header = res.headers.get('www-authenticate');
      // An MCP server that requires auth answers 401 with a single Bearer
      // challenge (RFC 9728): `Bearer resource_metadata="..."` for OAuth, or a
      // plain bearer-token requirement otherwise. A missing header is treated
      // as bearer; any non-Bearer scheme (Basic, Digest, ...) is surfaced as
      // unknown since the bearer/oauth flows cannot use it.
      const scheme = header?.trim().split(/\s+/, 1)[0]?.toLowerCase();

      if (header !== null && scheme !== 'bearer') {
        return await unknownWithBody(res);
      }

      await discardBody(res);
      const resourceMetadataUrl = parseResourceMetadataUrl(header);
      if (resourceMetadataUrl) {
        return { kind: 'oauth', resourceMetadataUrl };
      }
      const realm = parseRealm(header);
      return realm === undefined ? { kind: 'bearer' } : { kind: 'bearer', realm };
    }

    return await unknownWithBody(res);
  } catch (err) {
    deps.logger.debug({ err, url: url.toString() }, 'oauth-discovery probe failed');
    return { kind: 'unknown', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function terminateProbeSession(
  url: URL,
  sessionId: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  try {
    const res = await fetchFn(url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
      signal,
    });
    await discardBody(res);
  } catch (err) {
    logger.debug({ err, url: url.toString() }, 'oauth-discovery probe session cleanup failed');
  }
}

function parseRealm(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  // Anchor the param name to a boundary so `myrealm="x"` does not match `realm`.
  const match = /(?:^|[\s,])realm\s*=\s*"([^"]*)"/i.exec(header);
  return match?.[1];
}

function parseResourceMetadataUrl(header: string | null): URL | undefined {
  if (!header) {
    return undefined;
  }
  // Anchor the param name to a boundary so a similarly named param such as
  // `not_resource_metadata="..."` does not match `resource_metadata`.
  const match = /(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/i.exec(header);
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

async function unknownWithBody(res: Response): Promise<AuthHint> {
  const body = await readBodyExcerpt(res);
  return body === undefined
    ? { kind: 'unknown', status: res.status }
    : { kind: 'unknown', status: res.status, body };
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort cleanup; ignore failures cancelling the stream.
  }
}

/**
 * Read at most `MAX_BODY_EXCERPT` characters from the response body, cancelling
 * the stream early so a large error body does not get buffered in full during a
 * lightweight probe.
 */
async function readBodyExcerpt(res: Response): Promise<string | undefined> {
  const body = res.body;
  if (!body) {
    try {
      return truncate(await res.text());
    } catch {
      return undefined;
    }
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder = new TextDecoder();
  let collected = '';
  try {
    while (collected.length < MAX_BODY_EXCERPT) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = MAX_BODY_EXCERPT - collected.length;
      if (value.length > remaining) {
        // Cap how much of an oversized chunk we materialize; the few extra
        // bytes cover a multibyte sequence split at the budget boundary.
        collected += decoder.decode(value.subarray(0, remaining + 3));
        break;
      }
      collected += decoder.decode(value, { stream: true });
    }
    collected += decoder.decode();
    return truncate(collected);
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function truncate(text: string): string {
  return text.length > MAX_BODY_EXCERPT ? text.slice(0, MAX_BODY_EXCERPT) + '…' : text;
}
