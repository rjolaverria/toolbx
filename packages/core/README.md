# @toolbx/core

Shared core of [**Toolbx**](https://github.com/rjolaverria/Toolbx), a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

This package holds Toolbx's config loading and validation, the server registry, the proxy logic, tool namespacing, progressive disclosure, and auth (bearer tokens and OAuth 2.1 with keychain storage). It has no CLI-specific dependencies so it can also back the desktop app.

> **Internal building block.** Most people should install [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) and run the `tlbx` binary rather than depending on this package directly. Its API is not yet stable.

## Learn more

- [GitHub repository](https://github.com/rjolaverria/Toolbx)
- [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) — the user-facing Toolbx CLI.

## License

[MIT](https://github.com/rjolaverria/Toolbx/blob/main/LICENSE) © 2026 rjolaverria
