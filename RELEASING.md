# Releasing ToolBox

ToolBox ships as four public npm packages published together from this monorepo:

| Package                             | Purpose                                             | Published |
| ----------------------------------- | --------------------------------------------------- | --------- |
| `@rjolaverria/toolbox`              | The `tlbx` binary; what users run via `npx`         | ✅        |
| `@rjolaverria/toolbox-core`         | Config, registry, proxy, auth (dep of cli)          | ✅        |
| `@rjolaverria/toolbox-gateway`      | MCP protocol layer (dep of cli)                     | ✅        |
| `@rjolaverria/toolbox-custom-tools` | Custom-tool importer + on-disk sandbox (dep of cli) | ✅        |

End users only ever type `npx -y @rjolaverria/toolbox …` — npm resolves the other three
automatically. We publish all four (rather than one bundled artifact) because the
custom-tools sandbox spawns a child-process harness and re-imports modules **from
disk**, which a single-file bundle breaks. `pnpm publish` rewrites the internal
`workspace:^` references to real version ranges at publish time.

All four packages share one version and are released in lockstep.

## One-time setup

1. **npm account** that owns the `@rjolaverria` scope (every npm user owns the
   scope matching their username — no org to create). Log in: `npm login`.
2. **A token that can publish to `@rjolaverria`.** If your account has 2FA on
   writes, a plain login session prompts for it at publish time. For
   non-interactive publishing (or to avoid a passkey/Touch-ID prompt mid-publish),
   create a token with publish rights to the `@rjolaverria` scope:
   - **Classic → Automation** token (full publish rights, bypasses 2FA), or
   - **Granular** token granting **Read and write** on the `@rjolaverria` scope.
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
registry (verdaccio), does a clean global install of `@rjolaverria/toolbox`, and runs the
real user journeys — upstream tool calls **and** the custom-tool import → list →
run path that proves the on-disk sandbox works from an installed layout:

```bash
bash scripts/verify-publish.sh
# expect: ✓ PUBLISHED SHAPE VERIFIED — npx @rjolaverria/toolbox works end-to-end
```

Do not publish if this fails.

### 3. Set the version (all four, in lockstep)

For `0.1.0` the versions are already set. For subsequent releases, bump every
package's `version` to the new value and keep them identical:

```bash
# packages/core, packages/custom-tools, packages/mcp-gateway, apps/cli
# all set "version": "X.Y.Z"
```

(The internal `@rjolaverria/toolbox-*` deps stay `workspace:^`; pnpm resolves
them to `^X.Y.Z` at publish time.)

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
npm view @rjolaverria/toolbox version          # X.Y.Z
bash scripts/verify-tarball.sh --from-npm @rjolaverria/toolbox@X.Y.Z
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
the `@rjolaverria` scope). Add that secret under
_Settings → Secrets and variables → Actions_ before the first automated release.

## Renaming the packages

The published names are centralized, so a future rename (e.g. to a dedicated org
scope) is a small, mechanical change:

1. **`packages/core/src/clients/toolbox-command.ts`** — `TOOLBOX_NPX_PACKAGE` is
   the single source of the name clients are wired with (`npx -y <name> serve`).
2. **The four `package.json` `name` fields** (`apps/cli`, `packages/core`,
   `packages/mcp-gateway`, `packages/custom-tools`) and the internal
   `dependencies` keys that reference them.
3. **Imports** — every `from '@rjolaverria/toolbox-*'` specifier in source/tests
   (`grep -rn '@rjolaverria/toolbox'`), plus the `README.md` / `CLAUDE.md`
   examples.

After renaming: delete `dist/` + `tsconfig.tsbuildinfo` (composite incremental
builds must be cleaned), `pnpm install`, `pnpm build`, then
`bash scripts/verify-publish.sh`. The client-snippet snapshot test updates to the
new name — review the diff.
