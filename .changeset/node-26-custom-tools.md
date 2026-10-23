---
'@toolbx/cli': patch
'@toolbx/core': patch
'@toolbx/custom-tools': patch
'@toolbx/mcp-gateway': patch
---

Custom tools now run on Node 26. Node 26 removed `--experimental-transform-types`, so every
custom tool call failed with "tool process exited without producing a result" (the child
exited on `node: bad option`). The runner now passes that flag only where Node accepts it;
on Node 26, which strips types natively but cannot transform them, the harness transpiles
TypeScript tools with the bundled compiler, so tools using `enum`, `namespace` or parameter
properties keep working.
