import { randomUUID } from 'node:crypto';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { Logger } from '../logging/logger.js';
import {
  CURRENT_OAUTH_SCHEMA_VERSION,
  type StoredOAuthRecord,
  type TokenStore,
} from './token-store.js';

export interface ToolBoxOAuthProviderOpts {
  serverName: string;
  redirectUrl: URL;
  /** Scopes to request when DCR happens. Optional; many MCP servers accept no scope. */
  scopes?: string[];
  tokenStore: TokenStore;
  logger: Logger;
  /** Static client metadata for DCR. */
  clientName?: string;
  /**
   * Optional fallback authorization-server URL persisted into
   * StoredOAuthRecord.authorizationServer when the SDK has not resolved one for
   * this flow. In the normal login path the provider learns the issuer from the
   * SDK via `saveDiscoveryState` (preferred over this opt); this is only a seed
   * for callers that already know it.
   */
  authorizationServer?: string;
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

/**
 * Implements the SDK's OAuthClientProvider against a ToolBox TokenStore.
 *
 * One instance per (serverName, redirectUrl). Never reused across servers
 * or across CLI invocations — each login binds a fresh callback server.
 *
 * No persistent cache of TokenStore reads. The gateway-runtime instance of
 * this provider lives for the lifetime of the upstream session, and the user
 * can run `tlbx auth login <server>` from a separate terminal to refresh
 * tokens at any time (§4.6.2 recovery flow). Caching would mask those external
 * updates and prevent the auth_expired → connected transition. Keychain reads
 * are local and cheap.
 */
export class ToolBoxOAuthProvider implements OAuthClientProvider {
  // Atomicity: client info from a fresh DCR is held in-memory only. We never
  // write a partial record to the TokenStore — saveTokens is the single commit
  // point that writes clientInformation + tokens together, so a Ctrl-C between
  // DCR and the code exchange leaves the keychain unchanged.
  private pendingClientInformation: OAuthClientInformationMixed | undefined;
  private resolvedAuthorizationServer: string | undefined;
  private suppressTokensRead = false;
  private suppressClientRead = false;
  private savedCodeVerifier: string | undefined;
  // Discovery resolved by the SDK during the first auth() call, cached so the
  // later code-exchange call reuses the SAME authorization server instead of
  // rediscovering. Without this, DCR/authorize, the exchange, and the persisted
  // issuer could diverge if the server's metadata changes between calls.
  private discoveryStateCache: OAuthDiscoveryState | undefined;

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
      // Only emit `scope` when there is at least one scope: an empty string is
      // rejected as malformed by many OAuth servers, and callers normalize "no
      // scopes" to [].
      ...(this.opts.scopes && this.opts.scopes.length > 0
        ? { scope: this.opts.scopes.join(' ') }
        : {}),
    };
  }

  state(): Promise<string> {
    // SDK calls this to generate the OAuth `state` parameter.
    return Promise.resolve(randomUUID());
  }

  /** Called by F1-18 after the SDK resolves discovery; persisted in saveTokens. */
  setAuthorizationServer(url: string): void {
    this.resolvedAuthorizationServer = url;
  }

  /**
   * Called by F1-18 for identity-switch (`tlbx auth login`): makes `tokens()`
   * return `undefined` regardless of stored state so the SDK proceeds through
   * DCR + authorize. Stored tokens remain on disk until `saveTokens` writes the
   * new pair (atomicity preserved).
   */
  suppressStoredTokensForReauth(): void {
    this.suppressTokensRead = true;
  }

  /**
   * SDK recovery hook. After a recoverable token error (e.g. `invalid_grant`
   * from a refresh against an expired/revoked token), the SDK calls this and
   * retries `auth()`; we hide the offending credential in-memory so the retry
   * proceeds to DCR/authorize instead of re-reading the bad value. We never
   * delete the stored record here — `saveTokens` is the only commit point, so
   * the previous tokens survive on disk until a new exchange succeeds
   * (atomicity preserved, §4.6.2). `discovery` is a no-op: we do not cache
   * discovery state, so every `auth()` re-discovers already.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') {
      this.suppressTokensRead = true;
    }
    if (scope === 'all' || scope === 'client') {
      this.suppressClientRead = true;
      this.pendingClientInformation = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      this.savedCodeVerifier = undefined;
    }
    if (scope === 'all' || scope === 'discovery') {
      this.discoveryStateCache = undefined;
    }
  }

  /**
   * Returns discovery cached from an earlier `auth()` call in this flow so the
   * SDK skips re-discovery on the code-exchange call and reuses one
   * authorization server throughout.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discoveryStateCache;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discoveryStateCache = state;
    // The authorization server the SDK actually resolved for this flow is the
    // one we must persist with the tokens, so refreshes target the same issuer.
    this.resolvedAuthorizationServer = state.authorizationServerUrl;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.pendingClientInformation) {
      return this.pendingClientInformation;
    }
    if (this.suppressClientRead) {
      return undefined;
    }
    const record = await this.load();
    return record?.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // A fresh registration supersedes any invalidation: surface the new info.
    this.suppressClientRead = false;
    this.pendingClientInformation = info;
    return Promise.resolve();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.suppressTokensRead) {
      return undefined;
    }
    const record = await this.load();
    return record?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Reaching saveTokens means re-auth has produced a token-exchange result,
    // so the suppression window is over. Clear it up front rather than only on
    // a successful write: if a later step throws (validation, keychain write),
    // the still-valid stored tokens must resurface instead of the provider
    // staying stuck returning undefined from tokens() for its lifetime.
    this.suppressTokensRead = false;
    this.suppressClientRead = false;
    const existing = await this.load();
    const clientInformation = this.pendingClientInformation ?? existing?.clientInformation;
    if (!clientInformation) {
      throw new Error(
        `Cannot save tokens for ${this.opts.serverName} before clientInformation; ` +
          'the SDK should call saveClientInformation first.',
      );
    }
    const authorizationServer =
      this.resolvedAuthorizationServer ??
      this.opts.authorizationServer ??
      existing?.authorizationServer;
    if (!authorizationServer) {
      // We refuse to persist with an empty authorizationServer — refresh would
      // have no endpoint to call against. F1-18 must either set it via
      // setAuthorizationServer or pass it in opts before the SDK calls
      // saveTokens.
      throw new Error(
        `Cannot save tokens for ${this.opts.serverName} without an authorization server URL. ` +
          'Call provider.setAuthorizationServer(...) before the token exchange completes.',
      );
    }
    // The RFC 8707 resource indicator the SDK selected for this flow. The
    // default `selectResourceURL` returns the `resource` advertised in RFC 9728
    // protected-resource metadata, which the SDK hands us via saveDiscoveryState;
    // when no protected-resource metadata exists it selects none, and we persist
    // none so refresh stays resource-free. Fall back to any previously stored
    // resource so a refresh-style re-save does not drop it.
    const resource = this.discoveryStateCache?.resourceMetadata?.resource ?? existing?.resource;
    const next: StoredOAuthRecord = {
      schemaVersion: CURRENT_OAUTH_SCHEMA_VERSION,
      clientInformation,
      tokens,
      authorizationServer,
      scopes: existing?.scopes ?? this.opts.scopes ?? [],
      ...(resource !== undefined ? { resource } : {}),
      obtainedAt: new Date().toISOString(),
    };
    await this.opts.tokenStore.write(this.opts.serverName, next);
    this.pendingClientInformation = undefined;
  }

  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // The SDK calls this to *display* the URL. We don't open the browser here —
    // the CLI does that, because only the CLI has user consent. Surface the URL
    // via the SuppressedRedirectError seam for the login flow to handle.
    this.opts.logger.debug({ url: authorizationUrl.toString() }, 'authorization URL ready');
    return Promise.reject(new SuppressedRedirectError(authorizationUrl));
  }

  saveCodeVerifier(verifier: string): Promise<void> {
    this.savedCodeVerifier = verifier;
    return Promise.resolve();
  }

  codeVerifier(): Promise<string> {
    if (this.savedCodeVerifier === undefined) {
      return Promise.reject(new Error('codeVerifier requested before saveCodeVerifier'));
    }
    return Promise.resolve(this.savedCodeVerifier);
  }

  private load(): Promise<StoredOAuthRecord | null> {
    // Read-through: every call hits the TokenStore so external token refreshes
    // (via `tlbx auth login`) are picked up automatically. See class-level
    // comment above for the rationale.
    return this.opts.tokenStore.read(this.opts.serverName);
  }
}
