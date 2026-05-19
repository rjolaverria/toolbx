# F1-15 — OAuth discovery probe

**Milestone**: Phase 1 follow-up (OAuth upstream auth, protocol primitives)
**SPECS references**: §4.6.2 (auto-trigger at add-http via probe)
**Depends on**: — (independent; can run in parallel with F1-13/F1-14/F1-16/F1-17)

## Goal

Probe an arbitrary HTTP URL and report which authentication scheme it requires, in a single async call that never throws on HTTP errors.

## Motivation

Auto-detect is the user-facing reason `tlbx server add-http` can run without an `--auth` flag. The probe is the gate that branches between "no auth," "bearer," "OAuth," and "ask the user" inside `server-add-http.ts` (F1-20). Keeping it as a tightly-scoped pure-ish helper means F1-20 stays simple and the probe is testable in isolation against HTTP response fixtures.

## Deliverables

- **`packages/core/src/auth/oauth-discovery.ts`** — new file:

  ```ts
  import {
    extractResourceMetadataUrl,
    extractWWWAuthenticateParams,
  } from '@modelcontextprotocol/sdk/client/auth.js';
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

  /**
   * Probe an HTTP MCP endpoint to classify its authentication requirement.
   *
   * Sends a minimal unauthenticated POST `initialize` (the same request the
   * SDK's StreamableHTTPClientTransport sends first) and inspects the response.
   *
   * Never throws on HTTP errors. Network timeouts and transport failures map
   * to `{ kind: 'unknown', status: 0 }` so callers can degrade gracefully.
   */
  export async function probeUpstreamAuth(
    url: URL,
    deps: ProbeUpstreamAuthDeps,
  ): Promise<AuthHint> {
    const fetchFn = deps.fetchFn ?? fetch;
    const timeoutMs = deps.timeoutMs ?? 10_000;
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

      if (res.ok) return { kind: 'none' };

      if (res.status === 401) {
        const params = extractWWWAuthenticateParams(res);
        const resourceMetadataUrl = extractResourceMetadataUrl(res);
        if (resourceMetadataUrl) {
          return { kind: 'oauth', resourceMetadataUrl };
        }
        return { kind: 'bearer', realm: params?.realm };
      }

      const bodyExcerpt = await readBodyExcerpt(res);
      return { kind: 'unknown', status: res.status, body: bodyExcerpt };
    } catch (err) {
      deps.logger.debug({ err, url: url.toString() }, 'oauth-discovery probe failed');
      return { kind: 'unknown', status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBodyExcerpt(res: Response): Promise<string | undefined> {
    try {
      const text = await res.text();
      return text.length > 512 ? text.slice(0, 512) + '…' : text;
    } catch {
      return undefined;
    }
  }
  ```

  Confirm the SDK import path against `@modelcontextprotocol/sdk@1.29.0` before committing — adjust to `@modelcontextprotocol/sdk/client/auth-extensions.js` if the named exports live there instead.

- **`packages/core/src/auth/__tests__/oauth-discovery.test.ts`** — tests using a stubbed `fetchFn`:
  - **200 OK** → `{ kind: 'none' }`.
  - **401 with `WWW-Authenticate: Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"`** → `{ kind: 'oauth', resourceMetadataUrl: <URL> }`.
  - **401 with `WWW-Authenticate: Bearer realm="foo"` (no resource_metadata)** → `{ kind: 'bearer', realm: 'foo' }`.
  - **401 with no `WWW-Authenticate` header** → `{ kind: 'bearer', realm: undefined }`.
  - **403** → `{ kind: 'unknown', status: 403, body: <excerpt> }`.
  - **404** → `{ kind: 'unknown', status: 404 }`.
  - **500 with > 512-byte body** → `body` is truncated to 512 chars + `…`.
  - **Network throw (TypeError 'fetch failed')** → `{ kind: 'unknown', status: 0 }` (does not propagate).
  - **AbortError after timeout** → `{ kind: 'unknown', status: 0 }` (does not propagate). Use a stubbed fetch that never resolves and assert the timeout fires within the configured ms.

- **`packages/core/src/auth/index.ts`** — export `probeUpstreamAuth` and `AuthHint`.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- Every `AuthHint` variant is reachable via at least one test fixture.
- `probeUpstreamAuth` never throws under any tested condition (verified by `expect(...).resolves` on every test).
- The timeout default (10 seconds) is configurable via `deps.timeoutMs` and verified by a test using `vi.useFakeTimers()`.

## Out of scope

- Calling `probeUpstreamAuth` from `server-add-http` — that's F1-20.
- Probing for OAuth metadata endpoints (`/.well-known/oauth-authorization-server`) — that's the SDK's job inside the login flow (F1-18).
- Caching probe results.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
