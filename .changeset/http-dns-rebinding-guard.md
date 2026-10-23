---
'@toolbx/cli': patch
'@toolbx/core': patch
'@toolbx/custom-tools': patch
'@toolbx/mcp-gateway': patch
---

Security: the Streamable HTTP gateway (`tlbx serve` in HTTP mode) now rejects requests whose
`Host` header is not a loopback name on the bound port, and browser requests whose `Origin` is
not that same loopback address. Previously a web page could reach the loopback-only listener
through DNS rebinding (a hostname that resolves to 127.0.0.1) and call every tool behind the
gateway, including OAuth-authenticated upstreams and custom tools. Non-browser MCP clients are
unaffected.
