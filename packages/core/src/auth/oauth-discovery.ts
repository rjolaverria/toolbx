import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';

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
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'toolbox-probe', version: '0' },
        },
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      return { kind: 'none' };
    }

    if (res.status === 401) {
      const { resourceMetadataUrl } = extractWWWAuthenticateParams(res);
      if (resourceMetadataUrl) {
        return { kind: 'oauth', resourceMetadataUrl };
      }
      const realm = parseRealm(res.headers.get('www-authenticate'));
      return realm === undefined ? { kind: 'bearer' } : { kind: 'bearer', realm };
    }

    const bodyExcerpt = await readBodyExcerpt(res);
    return bodyExcerpt === undefined
      ? { kind: 'unknown', status: res.status }
      : { kind: 'unknown', status: res.status, body: bodyExcerpt };
  } catch (err) {
    deps.logger.debug({ err, url: url.toString() }, 'oauth-discovery probe failed');
    return { kind: 'unknown', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function parseRealm(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /realm\s*=\s*"([^"]*)"/i.exec(header);
  return match?.[1];
}

async function readBodyExcerpt(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > MAX_BODY_EXCERPT ? text.slice(0, MAX_BODY_EXCERPT) + '…' : text;
  } catch {
    return undefined;
  }
}
