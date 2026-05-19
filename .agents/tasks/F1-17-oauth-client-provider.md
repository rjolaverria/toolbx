# F1-17 — OAuthClientProvider implementation

**Milestone**: Phase 1 follow-up (OAuth upstream auth, SDK adapter)
**SPECS references**: §4.6.2 (library decision: lean on SDK)
**Depends on**: F1-13

## Goal

Implement the SDK's `OAuthClientProvider` interface, backed by our `TokenStore`. This is the adapter that lets the SDK do all the OAuth protocol work (discovery, DCR, PKCE, exchange, refresh) while ToolBox owns the storage and the redirect URI.

## Motivation

The SDK's `auth()` driver and the HTTP transport both consume an `OAuthClientProvider`. The interface has 8-10 methods, most of which are thin wrappers around a key-value store of `clientInformation` and `tokens`. Implementing it once, here, is what makes F1-18 (login orchestrator) and F1-21 (gateway runtime refresh) possible.

## Deliverables

- **`packages/core/src/auth/oauth-provider.ts`** — new file. Implements `OAuthClientProvider` from `@modelcontextprotocol/sdk/client/auth.js`. Approximate shape (confirm against the SDK source before committing — method names and signatures must match exactly):

  ```ts
  import type {
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthTokens,
  } from '@modelcontextprotocol/sdk/shared/auth.js';
  import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
  import type { Logger } from '../logging/logger.js';
  import type { StoredOAuthRecord, TokenStore } from './token-store.js';

  export interface ToolBoxOAuthProviderOpts {
    serverName: string;
    redirectUrl: URL;
    /** Scopes to request when DCR happens. Optional; many MCP servers accept no scope. */
    scopes?: string[];
    tokenStore: TokenStore;
    logger: Logger;
    /** Static client metadata for DCR. */
    clientName?: string;
  }

  /**
   * Implements the SDK's OAuthClientProvider against a ToolBox TokenStore.
   *
   * One instance per (serverName, redirectUrl). Never reused across servers
   * or across CLI invocations — each login binds a fresh callback server.
   */
  export class ToolBoxOAuthProvider implements OAuthClientProvider {
    private cached: StoredOAuthRecord | null | undefined;

    constructor(private readonly opts: ToolBoxOAuthProviderOpts) {}

    get redirectUrl(): URL {
      return this.opts.redirectUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: this.opts.clientName ?? `ToolBox (${this.opts.serverName})`,
        redirect_uris: [this.opts.redirectUrl.toString()],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // public client; PKCE
        ...(this.opts.scopes ? { scope: this.opts.scopes.join(' ') } : {}),
      };
    }

    async state(): Promise<string> {
      // SDK calls this to generate the OAuth `state` parameter.
      return crypto.randomUUID();
    }

    // Atomicity: client info from a fresh DCR is held in-memory only.
    // We never write a partial record to the TokenStore — saveTokens is the
    // single commit point that writes clientInformation + tokens together,
    // so a Ctrl-C between DCR and the code exchange leaves the keychain
    // unchanged.
    private pendingClientInformation: OAuthClientInformationFull | undefined;

    async clientInformation(): Promise<OAuthClientInformation | undefined> {
      if (this.pendingClientInformation) return this.pendingClientInformation;
      const record = await this.load();
      return record?.clientInformation;
    }

    async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
      this.pendingClientInformation = info;
    }

    async tokens(): Promise<OAuthTokens | undefined> {
      const record = await this.load();
      return record?.tokens;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      const existing = await this.load();
      const clientInformation = this.pendingClientInformation ?? existing?.clientInformation;
      if (!clientInformation) {
        throw new Error(
          `Cannot save tokens for ${this.opts.serverName} before clientInformation; ` +
            'the SDK should call saveClientInformation first.',
        );
      }
      const next: StoredOAuthRecord = {
        schemaVersion: 1,
        clientInformation,
        tokens,
        authorizationServer: existing?.authorizationServer ?? '',
        scopes: existing?.scopes ?? this.opts.scopes ?? [],
        obtainedAt: new Date().toISOString(),
      };
      await this.opts.tokenStore.write(this.opts.serverName, next);
      this.cached = next;
      this.pendingClientInformation = undefined;
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      // The SDK calls this to *display* the URL. We don't open the browser
      // here — the CLI does that, because only the CLI has user consent.
      // Surface the URL via the codeVerifier/state seam in the login flow.
      this.opts.logger.debug({ url: authorizationUrl.toString() }, 'authorization URL ready');
      throw new SuppressedRedirectError(authorizationUrl);
    }

    private savedCodeVerifier: string | undefined;

    async saveCodeVerifier(verifier: string): Promise<void> {
      this.savedCodeVerifier = verifier;
    }

    async codeVerifier(): Promise<string> {
      if (this.savedCodeVerifier === undefined) {
        throw new Error('codeVerifier requested before saveCodeVerifier');
      }
      return this.savedCodeVerifier;
    }

    private async load(): Promise<StoredOAuthRecord | null> {
      if (this.cached !== undefined) return this.cached;
      this.cached = await this.opts.tokenStore.read(this.opts.serverName);
      return this.cached;
    }
  }

  /**
   * Thrown from `redirectToAuthorization` so the CLI can intercept the URL,
   * decide when to open the browser, and await the callback server. The SDK
   * still cleans up its internal state because it sees this as a control-flow
   * exception, not an error.
   */
  export class SuppressedRedirectError extends Error {
    constructor(public readonly authorizationUrl: URL) {
      super('Authorization redirect intercepted by ToolBox');
      this.name = 'SuppressedRedirectError';
    }
  }
  ```

  **Caveat:** the exact `OAuthClientProvider` method names and signatures must come from the installed SDK source — re-check `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_*/dist/esm/client/auth.d.ts` before writing the implementation. The shape above is a faithful sketch but field names (`clientMetadata` vs `getClientMetadata`, `tokens()` vs `getTokens()`) may differ — match the SDK exactly, do not guess. The `SuppressedRedirectError` pattern is the F1-18 control-flow mechanism; if the SDK exposes a different cancellation seam (e.g. returning `{ kind: 'REDIRECT', url }` from `auth()`), use that instead and drop the error.

- **`packages/core/src/auth/__tests__/oauth-provider.test.ts`** — unit tests:
  - **`clientMetadata`** contains the correct `client_name`, `redirect_uris`, `grant_types`, `token_endpoint_auth_method: 'none'`, and scope when configured.
  - **`redirectUrl` is immutable** — assigning to it must be a TypeScript error (compile-time check; test as a TS-expect-error or just rely on `readonly` modifier).
  - **`clientInformation()` returns undefined for unknown server**, then returns the staged info after `saveClientInformation()` even before `saveTokens` has been called (in-memory only).
  - **`saveClientInformation` alone does not touch the TokenStore** — assert `tokenStore.read(name)` still returns `null` after `saveClientInformation` but before `saveTokens`. This is the atomicity guarantee from §4.6.2.
  - **`saveTokens` writes a complete record** with both the staged `clientInformation` and the new tokens, and clears the in-memory staged copy.
  - **`saveTokens` requires prior `saveClientInformation` (or an existing stored record)** — calling on a brand-new provider with no DCR and no prior record throws the expected error.
  - **Re-auth path (record already exists):** pre-seed the TokenStore with a record. `saveTokens` should write a new record reusing the existing `clientInformation` (and `authorizationServer` / `scopes`) — no `saveClientInformation` call needed.
  - **`saveTokens` updates `obtainedAt`** to current time.
  - **`state()`** returns a UUID-shaped string; two calls return distinct values.
  - **`saveCodeVerifier` + `codeVerifier`** round-trips; `codeVerifier` before save throws.
  - **`redirectToAuthorization` throws `SuppressedRedirectError`** with the URL attached.

- **`packages/core/src/auth/index.ts`** — export `ToolBoxOAuthProvider` and `SuppressedRedirectError`.

## Acceptance criteria

- All seven CLAUDE.md quality gates green.
- Provider methods match the installed SDK's `OAuthClientProvider` signatures exactly (verified by `pnpm typecheck` against the SDK type).
- Tests cover each provider method.
- `SuppressedRedirectError` is the documented control-flow seam between this provider and F1-18.

## Out of scope

- Composing the provider with the callback server and SDK's `auth()` helper — F1-18.
- Using the provider in the gateway's HTTP transport — F1-21.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md.
