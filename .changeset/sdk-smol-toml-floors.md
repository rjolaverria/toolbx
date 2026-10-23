---
'@toolbx/cli': patch
'@toolbx/core': patch
'@toolbx/custom-tools': patch
'@toolbx/mcp-gateway': patch
---

Raise the `@modelcontextprotocol/sdk` floor to `^1.32.1` (in `@toolbx/cli`, `@toolbx/core`
and `@toolbx/mcp-gateway`) and the `smol-toml` floor to `^1.9.1` (in `@toolbx/core`).

Unlike earlier range moves, these floors are deliberate: SDK releases before 1.32.0 carry
advisories that reach Toolbx's own server and client paths — an OAuth client that could send
credentials to the wrong authorization server, server bearer auth accepting tokens issued for
another resource, and an HTTP request that could exhaust memory within the default size limit.
smol-toml before 1.9.0 can be driven into denial of service by a malformed TOML document, and
Toolbx parses client TOML config. Raising the floor stops a consumer lockfile from holding the
vulnerable versions.
