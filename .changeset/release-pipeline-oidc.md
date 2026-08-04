---
'@toolbx/cli': patch
'@toolbx/core': patch
'@toolbx/custom-tools': patch
'@toolbx/mcp-gateway': patch
---

Release infrastructure only — no functional change. Releases are now versioned with
Changesets and published from CI using npm OIDC trusted publishing, so every package
ships with a provenance attestation. Package code is identical to the previous release.
