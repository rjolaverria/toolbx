# Releasing Toolbx

Toolbx ships as four public npm packages published together from this monorepo:

| Package                | Purpose                                             | Published |
| ---------------------- | --------------------------------------------------- | --------- |
| `@toolbx/cli`          | The `tlbx` binary; what users run via `npx`         | ✅        |
| `@toolbx/core`         | Config, registry, proxy, auth (dep of cli)          | ✅        |
| `@toolbx/mcp-gateway`  | MCP protocol layer (dep of cli)                     | ✅        |
| `@toolbx/custom-tools` | Custom-tool importer + on-disk sandbox (dep of cli) | ✅        |

End users only ever type `npx -y @toolbx/cli …` — npm resolves the other three
automatically. We publish all four (rather than one bundled artifact) because the
custom-tools sandbox spawns a child-process harness and re-imports modules **from
disk**, which a single-file bundle breaks. `pnpm publish` rewrites the internal
`workspace:^` references to real version ranges at publish time.

All four packages share one version and are released in lockstep.

## One-time setup

1. **npm account** that is a member of the `@toolbx` org with publish rights
   to the scope. Log in: `npm login`.
2. **A token that can publish to `@toolbx`.** If your account has 2FA on
   writes, a plain login session prompts for it at publish time. For
   non-interactive publishing (or to avoid a passkey/Touch-ID prompt mid-publish),
   create a token with publish rights to the `@toolbx` scope:
   - **Classic → Automation** token (full publish rights, bypasses 2FA), or
   - **Granular** token granting **Read and write** on the `@toolbx` scope.
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
registry (verdaccio), does a clean global install of `@toolbx/cli`, and runs the
real user journeys — upstream tool calls **and** the custom-tool import → list →
run path that proves the on-disk sandbox works from an installed layout:

```bash
bash scripts/verify-publish.sh
# expect: ✓ PUBLISHED SHAPE VERIFIED — npx @toolbx/cli works end-to-end
```

Do not publish if this fails.

### 3. Set the version (all four, in lockstep)

For `0.1.0` the versions are already set. For subsequent releases, bump every
package's `version` to the new value and keep them identical:

```bash
# packages/core, packages/custom-tools, packages/mcp-gateway, apps/cli
# all set "version": "X.Y.Z"
```

(The internal `@toolbx/*` deps stay `workspace:^`; pnpm resolves
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
npm view @toolbx/cli version          # X.Y.Z
bash scripts/verify-tarball.sh --from-npm @toolbx/cli@X.Y.Z
```

### 5. Tag and announce

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
gh release create vX.Y.Z --generate-notes
```

## Subsequent releases (automated)

After the initial hand-published releases, cutting a release is a single action:
**publish a GitHub Release** for the new `vX.Y.Z` tag. That triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds,
tests, and runs `pnpm -r publish --access public --no-git-checks --provenance`.

```bash
# after the version-bump PR is merged to main
gh release create vX.Y.Z --generate-notes
```

Publishing is **tokenless** via npm OIDC "trusted publishing" — there is no
`NPM_TOKEN` secret. GitHub's OIDC identity authenticates the workflow directly to
npm, and `--provenance` attaches a signed supply-chain attestation. This requires
pnpm 10.x (OIDC works on 10; it regressed on 11.0.8) and Node ≥ 22.14 (the
`.nvmrc` `22` resolves to a current 22.x on the runner).

### One-time trusted-publisher setup

Each of the four packages must have this repository registered as a trusted
publisher on npmjs.com **before** the first OIDC release (the package must already
exist on npm, which all four do):

For `@toolbx/cli`, `@toolbx/core`, `@toolbx/mcp-gateway`, and `@toolbx/custom-tools`:

1. npmjs.com → the package → **Settings → Trusted Publisher**.
2. Add a **GitHub Actions** publisher:
   - Repository owner / name: `rjolaverria/toolbx`
   - Workflow filename: `release.yml`
3. Save.

Once all four are configured, any published GitHub Release publishes all four
packages with provenance and no stored credential. The old `NPM_TOKEN` repository
secret is no longer used and can be deleted.

## Renaming the packages

The published names are centralized, so a future rename (e.g. to a dedicated org
scope) is a small, mechanical change:

1. **`packages/core/src/clients/toolbx-command.ts`** — `TOOLBX_NPX_PACKAGE` is
   the single source of the name clients are wired with (`npx -y <name> serve`).
2. **The four `package.json` `name` fields** (`apps/cli`, `packages/core`,
   `packages/mcp-gateway`, `packages/custom-tools`) and the internal
   `dependencies` keys that reference them.
3. **Imports** — every `from '@toolbx/*'` specifier in source/tests
   (`grep -rn '@toolbx/'`), plus the `README.md` / `CLAUDE.md`
   examples.

After renaming: delete `dist/` + `tsconfig.tsbuildinfo` (composite incremental
builds must be cleaned), `pnpm install`, `pnpm build`, then
`bash scripts/verify-publish.sh`. The client-snippet snapshot test updates to the
new name — review the diff.
