# @toolbx/mcp-gateway

MCP protocol layer for [**Toolbx**](https://github.com/rjolaverria/Toolbx), a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

This package wraps [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) and implements Toolbx as both an **MCP server** (for downstream clients like Claude, Codex, and OpenCode) and an **MCP client** (for upstream servers like Jira, GitHub, and Linear). It builds on [`@toolbx/core`](https://www.npmjs.com/package/@toolbx/core) for config, the server registry, namespacing, and auth.

> **Internal building block.** Most people should install [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) and run the `tlbx` binary rather than depending on this package directly. Its API is not yet stable.

## Learn more

- [GitHub repository](https://github.com/rjolaverria/Toolbx)
- [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) — the user-facing Toolbx CLI.

## License

[MIT](https://github.com/rjolaverria/Toolbx/blob/main/LICENSE) © 2026 rjolaverria
