# Releasing ToolBox

ToolBox ships as four public npm packages published together from this monorepo:

| Package                 | Purpose                                             | Published |
| ----------------------- | --------------------------------------------------- | --------- |
| `@toolbox/cli`          | The `tlbx` binary; what users run via `npx`         | ✅        |
| `@toolbox/core`         | Config, registry, proxy, auth (dep of cli)          | ✅        |
| `@toolbox/mcp-gateway`  | MCP protocol layer (dep of cli)                     | ✅        |
| `@toolbox/custom-tools` | Custom-tool importer + on-disk sandbox (dep of cli) | ✅        |

End users only ever type `npx -y @toolbox/cli …` — npm resolves the other three
automatically. We publish all four (rather than one bundled artifact) because the
custom-tools sandbox spawns a child-process harness and re-imports modules **from
disk**, which a single-file bundle breaks. `pnpm publish` rewrites the internal
`workspace:^` references to real version ranges at publish time.

All four packages share one version and are released in lockstep.

## One-time setup

1. **npm account** with publish rights. Log in: `npm login`.
2. **Claim the `@toolbox` org** on npm (first release only):
   - Create the organization at <https://www.npmjs.com/org/create> with the name
     `toolbox`, then ensure your account can publish to it.
   - **If `@toolbox` is already taken**, fall back to the unscoped name
     `toolbox-mcp` (confirmed available as of 2026-06-24). See
     [Renaming the package](#renaming-the-package-fallback) — it is a three-touch
     change.
3. **Node ≥ 22.7.0** and **pnpm ≥ 10** (`corepack enable`).

## Cutting a release

### 1. Green the quality bar

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:run
pnpm test:integration
```

All must pass. CI (`.github/workflows/ci.yml`) runs the same on `ubuntu-latest`,
including the integration suite that exercises the custom-tools sandbox on Linux.

### 2. Verify the published shape

This is the critical step. It publishes all four packages to a throwaway local
registry (verdaccio), does a clean global install of `@toolbox/cli`, and runs the
real user journeys — upstream tool calls **and** the custom-tool import → list →
run path that proves the on-disk sandbox works from an installed layout:

```bash
bash scripts/verify-publish.sh
# expect: ✓ PUBLISHED SHAPE VERIFIED — npx @toolbox/cli works end-to-end
```

Do not publish if this fails.

### 3. Set the version (all four, in lockstep)

For `0.1.0` the versions are already set. For subsequent releases, bump every
package's `version` to the new value and keep them identical:

```bash
# packages/core, packages/custom-tools, packages/mcp-gateway, apps/cli
# all set "version": "X.Y.Z"
```

(The internal `@toolbox/*` deps stay `workspace:^`; pnpm resolves them to
`^X.Y.Z` at publish time.)

### 4. Publish (manual for 0.1.0)

```bash
pnpm build
pnpm -r publish --access public
```

`pnpm -r publish` walks the workspace in dependency order, rewrites
`workspace:^` → `^X.Y.Z`, and publishes each package. `prepublish` safety: the
build in step 1/2 is authoritative; `--access public` is required because the
scope is new.

Verify the live packages:

```bash
npm view @toolbox/cli version          # X.Y.Z
bash scripts/verify-tarball.sh --from-npm @toolbox/cli@X.Y.Z
```

### 5. Tag and announce

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
gh release create vX.Y.Z --generate-notes
```

## Subsequent releases (automated)

`0.1.0` is published by hand to confirm the flow. After that, a tagged release is
published by CI: pushing a `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds,
tests, and runs `pnpm -r publish --access public --no-git-checks` using the
`NPM_TOKEN` repository secret (an npm **automation** token with publish rights to
the `@toolbox` scope). Add that secret under
_Settings → Secrets and variables → Actions_ before the first automated release.

## Renaming the package (fallback)

If the `@toolbox` org is unavailable, rename to `toolbox-mcp`. The published name
is centralized, so this is a three-touch change:

1. **`packages/core/src/clients/toolbox-command.ts`** — the single source of the
   name clients are wired with:
   ```ts
   export const TOOLBOX_NPX_PACKAGE = 'toolbox-mcp'; // was '@toolbox/cli'
   ```
2. **`apps/cli/package.json`** — `"name": "toolbox-mcp"`. (Drop the scope; an
   unscoped public package needs no `publishConfig.access`.) The three
   `@toolbox/*` libraries can keep their scope or move to `toolbox-mcp-*` — they
   are deps, not the entry point, so users never type them.
3. **Docs** — `README.md` and `CLAUDE.md` examples (`grep -rn '@toolbox/cli'`).

Re-run `pnpm build` and `bash scripts/verify-publish.sh` after the rename; the
client-snippet snapshot test will update to the new name (review the diff).
