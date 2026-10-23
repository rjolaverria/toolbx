# @toolbx/cli

## 0.1.6

### Patch Changes

- 21f0ab1: Security: the Streamable HTTP gateway (`tlbx serve` in HTTP mode) now rejects requests whose
  `Host` header is not a loopback name on the bound port, and browser requests whose `Origin` is
  not that same loopback address. Previously a web page could reach the loopback-only listener
  through DNS rebinding (a hostname that resolves to 127.0.0.1) and call every tool behind the
  gateway, including OAuth-authenticated upstreams and custom tools. Non-browser MCP clients are
  unaffected.
- 6f636a8: Custom tools now run on Node 26. Node 26 removed `--experimental-transform-types`, so every
  custom tool call failed with "tool process exited without producing a result" (the child
  exited on `node: bad option`). The runner now passes that flag only where Node accepts it;
  on Node 26, which strips types natively but cannot transform them, the harness transpiles
  TypeScript tools with the bundled compiler, so tools using `enum`, `namespace` or parameter
  properties keep working.
- 21f0ab1: Raise the `@modelcontextprotocol/sdk` floor to `^1.32.1` (in `@toolbx/cli`, `@toolbx/core`
  and `@toolbx/mcp-gateway`) and the `smol-toml` floor to `^1.9.1` (in `@toolbx/core`).

  Unlike earlier range moves, these floors are deliberate: SDK releases before 1.32.0 carry
  advisories that reach Toolbx's own server and client paths — an OAuth client that could send
  credentials to the wrong authorization server, server bearer auth accepting tokens issued for
  another resource, and an HTTP request that could exhaust memory within the default size limit.
  smol-toml before 1.9.0 can be driven into denial of service by a malformed TOML document, and
  Toolbx parses client TOML config. Raising the floor stops a consumer lockfile from holding the
  vulnerable versions.

- Updated dependencies [21f0ab1]
- Updated dependencies [6f636a8]
- Updated dependencies [21f0ab1]
  - @toolbx/core@0.1.6
  - @toolbx/custom-tools@0.1.6
  - @toolbx/mcp-gateway@0.1.6

## 0.1.5

### Patch Changes

- e67ba2e: Add `repository`, `homepage`, and `bugs` metadata to every published package. npm
  validates `repository.url` against the provenance attestation at publish time, so the
  three library packages could not be published with provenance without it. Package
  code is unchanged.
- Updated dependencies [e67ba2e]
  - @toolbx/core@0.1.5
  - @toolbx/custom-tools@0.1.5
  - @toolbx/mcp-gateway@0.1.5

## 0.1.4

### Patch Changes

- a477090: Release infrastructure only — no functional change. Releases are now versioned with
  Changesets and published from CI using npm OIDC trusted publishing, so every package
  ships with a provenance attestation. Package code is identical to the previous release.
- Updated dependencies [a477090]
  - @toolbx/core@0.1.4
  - @toolbx/custom-tools@0.1.4
  - @toolbx/mcp-gateway@0.1.4

## 0.1.3

### Patch Changes

- 8c4d0b0: Release infrastructure only — no functional change. Releases are now versioned with
  Changesets and published from CI using npm OIDC trusted publishing, so every package
  ships with a provenance attestation. Package code is identical to the previous release.
- Updated dependencies [8c4d0b0]
  - @toolbx/core@0.1.3
  - @toolbx/custom-tools@0.1.3
  - @toolbx/mcp-gateway@0.1.3
