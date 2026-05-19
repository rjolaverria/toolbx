# F1-21 — Gateway OAuth wiring + lazy refresh + auth_expired surface

**Milestone**: Phase 1 follow-up (OAuth upstream auth, gateway runtime)
**SPECS references**: §4.6.2 (re-auth flow, refresh policy, browser-flow ownership)
**Depends on**: F1-17

## Goal

Make the gateway's HTTP upstream client speak OAuth: instantiate `ToolBoxOAuthProvider` when `auth.type === 'oauth'`, pass it to the SDK's HTTP transport, map SDK auth errors to ToolBox's `UpstreamAuthRequiredError`, attempt one refresh on 401, and surface `auth_expired` to MCP clients as a structured tool-call error.

## Motivation

Up to this task, OAuth is only exercised by the CLI. This task is what makes OAuth actually work when Claude (or any MCP client) calls a tool on an OAuth-protected upstream. SPECS §4.6.2 specifies the runtime behavior precisely; this task implements it.

## Deliverables

- **`packages/mcp-gateway/src/upstream-client/http.ts`** (modify):
  1. Read the server's auth config. When `auth.type === 'oauth'`:
     - Construct a `ToolBoxOAuthProvider` from `@toolbox/core/auth`. The provider's `redirectUrl` is **not used** in the gateway runtime path (it's only relevant during `tlbx auth login`), but the SDK's `OAuthClientProvider` interface still requires it. Use a placeholder URL like `http://127.0.0.1:0/unused` and document why in a one-line comment — the SDK will not initiate a browser flow from the runtime because we already have tokens stored.
     - Pass the provider to the SDK's `StreamableHTTPClientTransport` constructor as the `authProvider` option (or whatever the SDK's name is — verify against `@modelcontextprotocol/sdk@1.29.0` source).
     - Pass the configured `TokenStore` (read from `config.auth.storage` via the factory) to the provider.

  2. When the transport raises the SDK's `UnauthorizedError` during `connect()`, distinguish two cases:
     - **No stored token at all** (`tokenStore.read(name)` returns `null`): throw `UpstreamAuthRequiredError` → status becomes `auth_required`. This is the "user has never authenticated this server" state, recoverable by `tlbx auth login <name>`.
     - **Stored token exists but refresh fails** (token expired AND no usable refresh_token, or the refresh request itself errored): throw `UpstreamAuthExpiredError` → status becomes `auth_expired`. This is the "your previous auth has run out" state, recoverable by the same command but with a different user-facing message and a different recovery surface (tool-call returns the structured error per §4.6.2).
     - **Stored token exists and refresh succeeds**: retry the connect with the fresh token; status becomes `connected`. No error surfaces.

  3. The provider's `redirectToAuthorization` path **must not be reached** during gateway runtime. If `SuppressedRedirectError` ever bubbles up to `http.ts`, that's a bug — log it, throw `UpstreamAuthRequiredError`, and document this in a comment.

- **`packages/mcp-gateway/src/upstream-client/http.ts`** — call wrapping for refresh-on-401-retry-once:

  Wrap every `client.callTool(...)` and `client.listTools(...)` call so that on receiving a 401 (or the SDK's typed equivalent), the wrapper calls `refreshAuthorization` once and retries. On refresh failure, the wrapper does NOT throw `UpstreamAuthRequiredError`; instead, it throws a new typed error `UpstreamAuthExpiredError` so the session state machine (existing code in `upstream-client/session.ts`) can transition to `auth_expired` distinct from `auth_required`.

- **`packages/mcp-gateway/src/upstream-client/errors.ts`** (modify): add a new error class:

  ```ts
  export class UpstreamAuthExpiredError extends Error {
    constructor(
      public readonly serverName: string | undefined,
      message: string,
    ) {
      super(message);
      this.name = 'UpstreamAuthExpiredError';
    }
  }
  ```

- **`packages/mcp-gateway/src/upstream-client/session.ts`** (modify): handle the new error:
  - Add `phase: { kind: 'auth_expired' }` alongside the existing `auth_required` phase.
  - When `runConnectAttempt` or a tool-call path throws `UpstreamAuthExpiredError`, transition the phase to `auth_expired` and the `ServerStatus` to `{ kind: 'auth_expired', reason: <error message> }`.
  - From `auth_expired`, the next tool-call attempt should re-read tokens from the TokenStore and try to connect again. If the keychain now has fresh tokens (because the user ran `tlbx auth login`), the connect succeeds and the phase transitions back to `connected`. If the keychain still has the same expired tokens, return the structured error to the caller (see below).

- **`packages/mcp-gateway/src/downstream-server/handlers/tools-call.ts`** (modify; or wherever the existing `tools/call` handler lives — likely under `mcp-gateway/src/downstream-server/` per the M2-05 file layout): when a tool call resolves with an `UpstreamAuthExpiredError`, return a `CallToolResult` with:

  ```ts
  {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `Authentication for "${serverName}" has expired.\n\n` +
          `Run \`tlbx auth login ${serverName}\` in a terminal to re-authenticate.\n` +
          `ToolBox will pick up the new token automatically on the next call.`,
      },
    ],
  }
  ```

  Do **not** propagate this as a JSON-RPC error — the user sees these errors rendered by Claude, and a structured tool-call error renders better than a JSON-RPC failure.

- **`packages/mcp-gateway/src/upstream-client/__tests__/http-oauth.test.ts`** — new integration test file. Use the F1-18 fake auth server fixture plus a mock upstream MCP HTTP server. Tests:
  - **Happy connect** with a pre-seeded valid token: gateway initializes, lists tools, calls a tool. All requests carry `Authorization: Bearer <token>` matching the stored token.
  - **Refresh on 401 succeeds:** pre-seed an expired access token + valid refresh token. Mock upstream returns 401 once, then 200. Gateway issues a refresh request and retries the call. Tool-call resolves successfully; tokenStore has new tokens; status registry shows `connected`.
  - **Refresh fails (revoked refresh token):** pre-seed expired access + revoked refresh. Mock upstream 401, fake auth server returns `invalid_grant` on refresh. Gateway transitions to `auth_expired`. Tool-call resolves with `isError: true` and the documented recovery message containing `tlbx auth login`.
  - **Recovery from auth_expired:** after the above, update the tokenStore in-place with fresh tokens (simulating the user running `tlbx auth login`). Next tool-call should succeed; status transitions back to `connected`.
  - **No-refresh-token case:** pre-seed access token only (no refresh). 401 from upstream. Gateway transitions directly to `auth_expired` without attempting refresh (since there's no refresh token to use). This is the "previously authenticated, token aged out" case.
  - **No stored token at all (connect-time):** start gateway with `config.servers[name].auth = { type: 'oauth' }` but `tokenStore.read(name) === null`. Connect attempt fires `UnauthorizedError`; gateway transitions to `auth_required` (not `auth_expired`). Distinguish from the previous case in the assertion: `status.kind === 'auth_required'`.

- **`packages/core/src/server-status/state-machine.ts`** (already supports `auth_expired` per the existing types) — review and ensure the transitions added in this task are valid per the state-machine rules. Add a test if the transitions weren't previously covered.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- Refresh-on-401-retry-once is implemented and tested.
- `auth_expired` is reachable, and recovery to `connected` after a token refresh outside the gateway (via tokenStore.write) is tested.
- The structured tool-call error message exactly matches the text in SPECS §4.6.2 (modulo `<serverName>` interpolation).
- The gateway never opens a browser. If `SuppressedRedirectError` ever bubbles into the gateway, it's logged + remapped to `auth_required` (with a test asserting this).

## Out of scope

- Proactive background refresh — Phase 1 is lazy-only per SPECS §4.6.2.
- IPC between the running gateway and the CLI's `auth login` — SPECS §4.6.2 explicitly defers this; recovery is driven by next-call-re-read.
- Refresh attempts more than once per call — SPECS §4.6.2 says "one retry".

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
