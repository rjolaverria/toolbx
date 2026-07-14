# @toolbx/custom-tools

Custom-tool runtime for [**Toolbx**](https://github.com/rjolaverria/Toolbx), a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

This package lets you import your own local TypeScript/JavaScript tools and expose them through Toolbx alongside proxied upstream MCP tools. It handles the tool manifest and runs tool code inside a sandbox (via [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)), turning Toolbx from a pure MCP proxy into a lightweight local tool host.

> **Internal building block.** Most people should install [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) and use `tlbx tool import` rather than depending on this package directly. Its API is not yet stable.

## Learn more

- [GitHub repository](https://github.com/rjolaverria/Toolbx)
- [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) — the user-facing Toolbx CLI.

## License

[MIT](https://github.com/rjolaverria/Toolbx/blob/main/LICENSE) © 2026 rjolaverria
