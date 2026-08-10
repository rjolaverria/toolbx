# @toolbx/core

## 0.1.6

### Patch Changes

- 1d63826: Security maintenance: clear every advisory reported by `pnpm audit` in this repository
  (15 high, 25 moderate, 5 low → zero). All of them were transitive dependencies pinned by
  a stale lockfile rather than by any range this repo declares, so the fix is almost
  entirely a lockfile refresh. No Toolbx source changed.

  The one consumer-visible change is the `@modelcontextprotocol/sdk` range in
  `@toolbx/core` and `@toolbx/mcp-gateway`, which moves from `^1.29.0` to `^1.30.0`. SDK
  1.29.0 constrains `@hono/node-server` to `^1.19.9`; 1.30.0 widens that to
  `^1.19.9 || ^2.0.5`, which is what makes the patched adapter reachable at all.

  Scope note: reachable is not the same as guaranteed. Because the widened SDK range still
  _accepts_ the 1.19.x line, a downstream project whose own lockfile already resolves
  `@hono/node-server@1.19.14` can take this release and keep the vulnerable version. This
  repo cannot close that from its manifests — Toolbx has no direct dependency on
  `@hono/node-server`, and the narrowing belongs upstream in the SDK's own range.
  Consumers who need a hard guarantee should pin it themselves (`pnpm.overrides`,
  `resolutions`, or equivalent) until the SDK drops the 1.x branch.

## 0.1.5

### Patch Changes

- e67ba2e: Add `repository`, `homepage`, and `bugs` metadata to every published package. npm
  validates `repository.url` against the provenance attestation at publish time, so the
  three library packages could not be published with provenance without it. Package
  code is unchanged.

## 0.1.4

### Patch Changes

- a477090: Release infrastructure only — no functional change. Releases are now versioned with
  Changesets and published from CI using npm OIDC trusted publishing, so every package
  ships with a provenance attestation. Package code is identical to the previous release.

## 0.1.3

### Patch Changes

- 8c4d0b0: Release infrastructure only — no functional change. Releases are now versioned with
  Changesets and published from CI using npm OIDC trusted publishing, so every package
  ships with a provenance attestation. Package code is identical to the previous release.
