import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { ConfigLockError, withCredentialLock, type WithConfigLockOptions } from '../config/lock.js';
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
  /**
   * Config directory whose per-server-name credential lock (P3-08) serializes
   * token-store mutations. When set, `saveTokens` runs its read-modify-write
   * under `withCredentialLock(credentialLockDir, serverName)`, so a long-lived
   * gateway refresh contends on the same lock as the CLI credential commands
   * (`auth login | logout | refresh`, `server add-http`, `doctor --fix`) and
   * cannot interleave with them. Omitted by the CLI flows, which already hold
   * the lock for the whole command.
   */
  credentialLockDir?: string;
  /**
   * Acquire options for the credential lock around `saveTokens`. Defaults to
   * {@link withCredentialLock}'s own defaults (~10s acquire). A long-running
   * credential command (an interactive `tlbx auth login` waiting on the browser)
   * can hold the lock for minutes, so the gateway refresh fails fast rather than
   * blocking the triggering tool call — a timeout surfaces as a retryable
   * {@link CredentialChangedDuringRefreshError} (the credential is being
   * rewritten), not a terminal error.
   */
  credentialLockOptions?: WithConfigLockOptions;
}

/**
 * Thrown by `saveTokens` when a refresh-grant save (no authorization-code
 * exchange) cannot safely persist:
 *
 * - the stored credential was removed mid-refresh (`tlbx auth logout`), so
 *   persisting would resurrect a record the user deleted; or
 * - the per-server credential lock could not be acquired because a long-running
 *   credential command (an interactive `tlbx auth login` holding it across the
 *   browser handshake) is rewriting the credential.
 *
 * The gateway classifies this by re-reading the store: absent ⇒ `auth_required`,
 * present ⇒ `auth_expired` (which then recovers on the next read-through). A
 * credential that was *replaced* by a concurrent winner while still present is
 * not an error — `saveTokens` skips the stale write and the SDK retry uses the
 * winner's tokens.
 */
export class CredentialChangedDuringRefreshError extends Error {
  override readonly name = 'CredentialChangedDuringRefreshError';

  constructor(public readonly serverName: string) {
    super(
      `Stored credentials for ${serverName} were removed or replaced while a token ` +
        'refresh was in flight; the refreshed tokens were not persisted.',
    );
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

/**
 * A stable fingerprint of a stored record's identity, used to detect that the
 * credential was rewritten (by `tlbx auth login`) between the SDK's `tokens()`
 * read and the `saveTokens` it triggers. Every write stamps a fresh `obtainedAt`
 * and a server-issued `access_token`, so comparing these (plus the refresh
 * token) catches any rewrite — including a login that happens to preserve the
 * refresh token.
 */
/**
 * Cap on the set of own-written fingerprints kept per provider. Only fingerprints
 * that could still be the current stored record during a concurrent-refresh
 * window matter, so a small bound is ample and keeps the set from growing over a
 * long-lived gateway session.
 */
const OWN_WRITE_FINGERPRINT_LIMIT = 64;

function recordFingerprint(record: StoredOAuthRecord): string {
  return [record.obtainedAt, record.tokens.access_token, record.tokens.refresh_token ?? ''].join(
    '\u0000',
  );
}

type DiscoveredResourceSelection =
  | { kind: 'resource'; resource: URL }
  | { kind: 'none' }
  | { kind: 'invalid'; error: Error };

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
  // Whether this flow performed an authorization-code exchange (interactive
  // login/reauth) whose result has not yet been consumed by a token save. Only
  // that path freshly selects the RFC 8707 resource, so only then is the
  // discovered resource authoritative; a refresh grant never reaches here with
  // this set. Keying off the code-exchange path — not off saveDiscoveryState —
  // matters because the long-lived gateway provider runs discovery on connect
  // and may then be satisfied by a stored token (no save to consume a
  // discovery-based marker), after which a later refresh must keep the most
  // recent stored resource rather than a stale session-cached one. Set when the
  // SDK saves the PKCE verifier (authorization-code path only).
  private authorizationCodeExchangeInFlight = false;
  private useDiscoveredResourceForCodeExchange = false;
  private latestDiscoveredResourceSelection: DiscoveredResourceSelection = { kind: 'none' };
  // Per-operation record of the refresh token `tokens()` last returned to the
  // SDK. The SDK reads `tokens()` and then calls the `saveTokens()` it triggers
  // within one operation (one `auth()` call), so this is the lineage the
  // in-flight refresh started from. It must be per-operation, not a shared
  // field: the transport calls `tokens()` on every request (for the
  // Authorization header) with no dedup, so on this long-lived provider
  // concurrent operations would clobber one shared field — letting a stale
  // refresh save slip past the abort check. The cell is established by
  // `withRefreshScope`, which the upstream client wraps around each operation
  // (an ancestor of both the SDK's `tokens()` and `saveTokens()` calls); each
  // concurrent operation gets its own cell via `AsyncLocalStorage.run`, so a
  // parallel read writes a different cell and cannot corrupt an in-flight
  // refresh. `persistTokens` compares the captured source against the current
  // stored record under the credential lock to detect a concurrent `tlbx auth
  // login` that rebound the credential mid-refresh, aborting rather than
  // clobbering the newer login. Calls made outside any scope (e.g. a background
  // SDK stream reconnect) see an undefined cell and fall back to the
  // record-present/absent check alone.
  private readonly refreshScope = new AsyncLocalStorage<{ fingerprint: string | undefined }>();
  // Fallback lineage for refresh saves that run WITHOUT a `withRefreshScope`
  // cell — chiefly the SDK transport's standalone server→client SSE stream,
  // whose 401-triggered reconnects refresh from a detached `setTimeout` callback
  // outside any operation we wrap. That standalone stream is single and its
  // reconnects are serial, so its refreshes never overlap each other; a single
  // instance field is therefore a safe lineage for them. It is written only by
  // unscoped `tokens()` reads (scoped reads use their own cell), so a concurrent
  // scoped refresh cannot corrupt it. Without this, an unscoped refresh save
  // would have no lineage and could clobber a credential a concurrent `tlbx auth
  // login` just wrote.
  private fallbackRefreshFingerprint: string | undefined;
  // Records THIS provider instance has written, mapped from the written record's
  // fingerprint to the source fingerprint the write descended from. Used to tell a
  // *sibling* concurrent refresh (another operation on this provider that refreshed
  // the SAME source) apart from an external `tlbx auth login`/`auth refresh` and
  // from our own refresh of a *different* source. When a save finds the record
  // replaced: last-write-wins applies only when the replacement is our own write
  // that descended from the same source as this refresh — a true sibling, whose
  // rotation we must not drop. A replacement we did not write, or one we wrote from
  // a different source (e.g. a refresh of a credential the user re-logged into), is
  // not a sibling, so we skip rather than clobber it. Bounded — only the most
  // recent writes can still be the current stored record during a concurrency
  // window.
  private readonly ownWriteSources = new Map<string, string | undefined>();

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
   * Called by the browser login orchestration immediately before feeding the
   * callback code back into the SDK. At that point the SDK is no longer
   * refreshing stored credentials: it is exchanging an authorization code, so
   * the freshly discovered resource selection must win over any old refreshable
   * record still on disk.
   */
  useDiscoveredResourceForAuthorizationCodeExchange(): void {
    this.useDiscoveredResourceForCodeExchange = true;
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
      // The pending authorization-code flow is being torn down; drop its marker
      // so a later refresh save does not treat its discovery as authoritative.
      this.authorizationCodeExchangeInFlight = false;
      this.useDiscoveredResourceForCodeExchange = false;
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

  /**
   * Overrides the SDK's RFC 8707 resource-indicator selection. The SDK calls
   * this for every token request (authorize, code exchange, and refresh) with
   * the `resource` it derived from RFC 9728 protected-resource metadata, if any.
   *
   * A usable stored refresh token means the SDK will refresh rather than run an
   * interactive authorization-code exchange. On that refresh path the resource
   * the stored record was minted for is authoritative — so we replay it (kept
   * current by the read-through store) and ignore the SDK-supplied value, which
   * on the long-lived gateway provider can come from discovery cached in an
   * earlier flow and go stale after an external `tlbx auth login`. We re-validate
   * it against the current server (this method overrides the SDK's default
   * validation entirely) and omit it when none is stored or it no longer matches.
   *
   * Otherwise this is an interactive authorization (a new login, or a reauth that
   * suppressed the stored token): the freshly discovered metadata is
   * authoritative, validated the same way the SDK default does so advertised
   * metadata cannot redirect the audience away from the server.
   */
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    const discovered = this.selectDiscoveredResource(serverUrl, resource);
    this.latestDiscoveredResourceSelection = discovered;
    if (this.suppressTokensRead || this.useDiscoveredResourceForCodeExchange) {
      return this.unwrapDiscoveredResource(discovered);
    }

    const record = await this.load();
    if (record?.tokens.refresh_token !== undefined) {
      const stored = record.resource;
      if (
        stored !== undefined &&
        checkResourceAllowed({ requestedResource: serverUrl, configuredResource: stored })
      ) {
        return new URL(stored);
      }
      return undefined;
    }
    if (resource !== undefined) {
      return this.unwrapDiscoveredResource(discovered);
    }
    return undefined;
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

  /**
   * Runs `fn` inside a fresh refresh-lineage scope. The upstream client wraps
   * each operation (connect / listTools / callTool / ping) in this so the SDK's
   * `tokens()` read and the `saveTokens()` it triggers — both descendants of
   * `fn` — share one per-operation cell. Concurrent operations get independent
   * cells, so a parallel `tokens()` read cannot corrupt an in-flight refresh's
   * lineage (see {@link refreshScope}).
   */
  withRefreshScope<T>(fn: () => Promise<T>): Promise<T> {
    return this.refreshScope.run({ fingerprint: undefined }, fn);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.suppressTokensRead) {
      return undefined;
    }
    const record = await this.load();
    // Remember the fingerprint of the record handed to the SDK so `persistTokens`
    // can detect, under the lock, a credential rewritten out from under an
    // in-flight refresh. Scoped operations record it in their per-operation cell
    // (isolated from concurrent operations); an unscoped read (the standalone SSE
    // stream's serial reconnects) records it in the fallback field instead.
    const fingerprint = record === null ? undefined : recordFingerprint(record);
    const cell = this.refreshScope.getStore();
    if (cell !== undefined) {
      cell.fingerprint = fingerprint;
    } else {
      this.fallbackRefreshFingerprint = fingerprint;
    }
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
    // Capture the refresh lineage before crossing into the lock (whose own
    // AsyncLocalStorage `run` opens a child context). A scoped operation reads
    // its per-operation cell; an unscoped one (standalone SSE reconnect) reads
    // the serial fallback field.
    const cell = this.refreshScope.getStore();
    const sourceFingerprint =
      cell !== undefined ? cell.fingerprint : this.fallbackRefreshFingerprint;
    try {
      // The read-modify-write below runs under the per-server-name credential
      // lock (when configured), so a concurrent credential command — most
      // importantly `tlbx auth logout` — cannot interleave between the read of
      // the existing record and the write of the merged one.
      await this.runUnderCredentialLock(() => this.persistTokens(tokens, sourceFingerprint));
    } finally {
      // Consume the authorization-code marker even when persistence fails: a
      // later refresh save on this long-lived provider must fall back to the
      // current stored resource instead of this failed flow's discovery.
      this.authorizationCodeExchangeInFlight = false;
      this.useDiscoveredResourceForCodeExchange = false;
      this.latestDiscoveredResourceSelection = { kind: 'none' };
    }
  }

  private async runUnderCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.opts.credentialLockDir === undefined) {
      return fn();
    }
    try {
      return await withCredentialLock(
        this.opts.credentialLockDir,
        this.opts.serverName,
        fn,
        this.opts.credentialLockOptions ?? {},
      );
    } catch (error) {
      // A lock we could not acquire means a long-running credential command (an
      // interactive `tlbx auth login` holding the lock across the browser
      // handshake) is rewriting this credential. Surface it as the retryable
      // "changed during refresh" condition rather than a raw ConfigLockError so
      // the gateway classifies it as an auth state and retries, instead of
      // failing the upstream with a generic lock error.
      if (error instanceof ConfigLockError) {
        throw new CredentialChangedDuringRefreshError(this.opts.serverName);
      }
      throw error;
    }
  }

  private async persistTokens(
    tokens: OAuthTokens,
    sourceFingerprint: string | undefined,
  ): Promise<void> {
    const existing = await this.load();
    // A refresh grant only ever starts from a stored record (that is where the
    // refresh token came from). Under the lock, the stored credential may have
    // changed since this refresh read it; how we react depends on how it changed.
    // The code-exchange (interactive login) path is authoritative and
    // intentionally overwrites, so it skips this guard.
    if (!this.authorizationCodeExchangeInFlight) {
      if (existing === null) {
        // Removed mid-refresh (`tlbx auth logout`). Persisting would resurrect a
        // record the user deleted, so abort. The gateway surfaces this as
        // auth_required (the store re-read finds nothing).
        throw new CredentialChangedDuringRefreshError(this.opts.serverName);
      }
      const existingFingerprint = recordFingerprint(existing);
      if (sourceFingerprint !== undefined && existingFingerprint !== sourceFingerprint) {
        // The present record was replaced mid-refresh — its fingerprint no longer
        // matches this refresh's captured source. The fingerprint (not just the
        // refresh token) catches a login that rewrote the record while preserving
        // the refresh token. Every real refresh captures a lineage — scoped
        // operations in their cell, the standalone SSE stream in the fallback — so
        // an `undefined` source only arises for a flow with no preceding
        // `tokens()` read, which is not a refresh from a stored token and has
        // nothing to clobber; that case falls through to the normal write.
        //
        // Who wrote the replacement — and from which source — decides what we do:
        if (
          this.ownWriteSources.has(existingFingerprint) &&
          this.ownWriteSources.get(existingFingerprint) === sourceFingerprint
        ) {
          // This provider's own concurrent refresh of the SAME source — a true
          // sibling. Both descend from the same credential, so the later save
          // persists its rotation (last-write-wins) rather than dropping it —
          // dropping could leave the store with a refresh token a rotating server
          // has already superseded. Fall through to the write. (An own write from
          // a DIFFERENT source — e.g. a refresh of a credential the user re-logged
          // into — is not a sibling and falls to the skip branch below, so a stale
          // pre-relogin refresh cannot clobber it.)
        } else {
          // An external writer (`tlbx auth login`/`auth refresh` in another
          // process) rebound the credential. Do not clobber it, and do not fail:
          // the stored record holds valid credentials and the SDK re-reads the
          // now-current token on its automatic retry, so the request still
          // succeeds without moving the session into auth recovery.
          //
          // We deliberately skip rather than persist, even though an external
          // *refresh* of the same source could (on a rotating server) leave a
          // sibling rotation we then drop. The two external cases are
          // indistinguishable here — a login mints a new identity that must not be
          // clobbered, a refresh mints a sibling we'd prefer to keep — and
          // clobbering a login is the worse, more standard failure, so skip wins.
          // Standard rotation makes the dropped-sibling case benign anyway: two
          // exchanges of one source yield either independent valid children (the
          // stored one works) or trigger reuse detection that revokes the whole
          // grant (both dead, recovered by re-login). Distinguishing the cases
          // would need per-record lineage metadata — an on-disk token-store format
          // change that is out of scope — or serializing the cross-process
          // token-endpoint exchange, which the credential lock (save-only) does
          // not and should not cover.
          this.opts.logger.debug(
            { server: this.opts.serverName },
            'skipping stale refresh save; credential was rewritten by an external command',
          );
          return;
        }
      }
    }
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
    // The RFC 8707 resource indicator to persist. On a fresh authorization-code
    // exchange (interactive login/reauth) the SDK's selection is authoritative:
    // the `resource` advertised in RFC 9728 protected-resource metadata, or none
    // when the server advertises none. We take it verbatim — including "none" —
    // so a reauth against a server that dropped (or never had) a resource cannot
    // inherit a stale indicator and replay the wrong audience on later refreshes.
    // A refresh grant (no code exchange) keeps the most recent stored resource:
    // the long-lived gateway provider holds discovery from the initial connect,
    // so an external `tlbx auth login` may have rebound the resource since.
    const resource = this.authorizationCodeExchangeInFlight
      ? this.discoveryStateCache?.resourceMetadata?.resource
      : existing?.resource;
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
    this.rememberOwnWrite(recordFingerprint(next), sourceFingerprint);
    this.pendingClientInformation = undefined;
  }

  /**
   * Records a record this provider just wrote, keyed by its fingerprint and
   * carrying the source fingerprint it descended from, so a concurrent refresh can
   * recognize the replacement as its own *sibling* (same source → last-write-wins)
   * versus an external write or its own write from a different source (skip).
   * Bounded: only the most recent writes can still be the current stored record
   * during a concurrency window, so old entries are evicted in insertion order.
   */
  private rememberOwnWrite(fingerprint: string, sourceFingerprint: string | undefined): void {
    // Re-insert to refresh insertion order so a repeated fingerprint isn't evicted
    // prematurely.
    this.ownWriteSources.delete(fingerprint);
    this.ownWriteSources.set(fingerprint, sourceFingerprint);
    while (this.ownWriteSources.size > OWN_WRITE_FINGERPRINT_LIMIT) {
      const oldest = this.ownWriteSources.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.ownWriteSources.delete(oldest);
    }
  }

  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.applyDiscoveredResourceToAuthorizationUrl(authorizationUrl);
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
    // The SDK reads the PKCE verifier only when it actually exchanges an
    // authorization code (immediately before the token request that saveTokens
    // persists), never on a refresh grant or an abandoned authorize that built a
    // URL but never returned. So consuming it here — not saving it earlier —
    // marks the upcoming token save as a fresh authorization whose selected
    // resource is authoritative.
    this.authorizationCodeExchangeInFlight = true;
    return Promise.resolve(this.savedCodeVerifier);
  }

  private load(): Promise<StoredOAuthRecord | null> {
    // Read-through: every call hits the TokenStore so external token refreshes
    // (via `tlbx auth login`) are picked up automatically. See class-level
    // comment above for the rationale.
    return this.opts.tokenStore.read(this.opts.serverName);
  }

  private selectDiscoveredResource(
    serverUrl: string | URL,
    resource: string | undefined,
  ): DiscoveredResourceSelection {
    if (resource === undefined) {
      return { kind: 'none' };
    }
    if (!checkResourceAllowed({ requestedResource: serverUrl, configuredResource: resource })) {
      return {
        kind: 'invalid',
        error: new Error(
          `Protected resource ${resource} does not match expected ${serverUrl.toString()} (or origin)`,
        ),
      };
    }
    return { kind: 'resource', resource: new URL(resource) };
  }

  private unwrapDiscoveredResource(selection: DiscoveredResourceSelection): URL | undefined {
    if (selection.kind === 'invalid') {
      throw selection.error;
    }
    if (selection.kind === 'resource') {
      return selection.resource;
    }
    return undefined;
  }

  private applyDiscoveredResourceToAuthorizationUrl(authorizationUrl: URL): void {
    const resource = this.unwrapDiscoveredResource(this.latestDiscoveredResourceSelection);
    if (resource === undefined) {
      authorizationUrl.searchParams.delete('resource');
      return;
    }
    authorizationUrl.searchParams.set('resource', resource.href);
  }
}
