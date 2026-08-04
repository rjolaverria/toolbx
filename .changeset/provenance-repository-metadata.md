---
'@toolbx/cli': patch
'@toolbx/core': patch
'@toolbx/custom-tools': patch
'@toolbx/mcp-gateway': patch
---

Add `repository`, `homepage`, and `bugs` metadata to every published package. npm
validates `repository.url` against the provenance attestation at publish time, so the
three library packages could not be published with provenance without it. Package
code is unchanged.
