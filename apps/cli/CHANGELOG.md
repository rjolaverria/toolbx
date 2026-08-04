# @toolbx/cli

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
