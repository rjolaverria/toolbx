# @toolbx/custom-tools

Custom-tool runtime for [**Toolbx**](https://github.com/rjolaverria/Toolbx), a local MCP gateway that lets you configure your MCP servers once and connect every MCP client to one place.

This package lets you import your own local TypeScript/JavaScript tools and expose them through Toolbx alongside proxied upstream MCP tools. It handles the tool manifest and, in the default `auto` mode, runs tool code inside an OS-level sandbox (via [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)) when the host supports it. This is best-effort: if the sandbox is disabled (`customTools.sandbox.mode: "off"`) or the host lacks the required OS support, tools fall back to in-process hardening only. In `auto` mode you can set `customTools.sandbox.require: true` to fail closed when the OS sandbox is unavailable instead of falling back (it has no effect when `mode` is `"off"`, which never sandboxes). Only import tool code you trust.

> **Internal building block.** Most people should install [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) and use `tlbx tool import` rather than depending on this package directly. Its API is not yet stable.

## Learn more

- [GitHub repository](https://github.com/rjolaverria/Toolbx)
- [`@toolbx/cli`](https://www.npmjs.com/package/@toolbx/cli) — the user-facing Toolbx CLI.

## License

[MIT](https://github.com/rjolaverria/Toolbx/blob/main/LICENSE) © 2026 rjolaverria
