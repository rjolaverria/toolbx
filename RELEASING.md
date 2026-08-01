# Releasing Toolbx

Toolbx ships as four public npm packages, published together in lockstep:

| Package                | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `@toolbx/cli`          | The `tlbx` binary; what users run via `npx`         |
| `@toolbx/core`         | Config, registry, proxy, auth (dep of cli)          |
| `@toolbx/mcp-gateway`  | MCP protocol layer (dep of cli)                     |
| `@toolbx/custom-tools` | Custom-tool importer + on-disk sandbox (dep of cli) |

End users only ever type `npx -y @toolbx/cli …`; npm resolves the other three. We
publish all four (rather than one bundled artifact) because the custom-tools
sandbox spawns a child-process harness and re-imports modules **from disk**, which
a single-file bundle breaks. All four always share one version.

Releases are managed by [Changesets](https://github.com/changesets/changesets) and
published from CI — no manual version bumps, tags, or `npm publish`.

## Adding a changeset

Every PR with a user-facing change includes a changeset. Run:

```bash
pnpm changeset
```

Pick the bump level (patch / minor / major) and write a one-line summary — it
becomes the CHANGELOG entry. The four packages are a fixed lockstep group, so one
changeset bumps all of them together; choose the level of the most significant
change. Commit the generated `.changeset/*.md` file with your PR.

Skip the changeset only for changes that never reach users — CI, tests, internal
refactors, or repo docs.

## Cutting a release

Fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Merge PRs that carry changesets into `main`.
2. The workflow opens (and keeps updating) a **"Version Packages" PR** that applies
   the pending changesets: bumps every package to the next version and updates each
   CHANGELOG.
3. Review and merge that PR. On merge, the workflow builds, publishes all four to
   npm, and creates a GitHub Release per package tag.

There is no local publishing step.

## Publishing auth (OIDC trusted publishing)

Publishing is **tokenless**: GitHub's OIDC identity authenticates the workflow to
npm directly, npm attaches a provenance attestation automatically, and there is no
`NPM_TOKEN` secret to rotate or leak.

One-time setup — a **trusted publisher** on npmjs.com for each package. For
`@toolbx/cli`, `@toolbx/core`, `@toolbx/mcp-gateway`, and `@toolbx/custom-tools`:
the package's **Settings → Trusted Publisher → GitHub Actions**, repository
`rjolaverria/toolbx`, workflow filename `release.yml`. Requires pnpm 10.x (OIDC
works on 10, regressed on 11.0.8) and Node ≥ 22.14 — both already pinned via
`packageManager` and `.nvmrc`, and the repo must be public.

## Manual publish (break-glass)

If OIDC is ever unavailable, publish from a trusted machine after a green
published-shape check. `scripts/verify-publish.sh` publishes to a throwaway local
verdaccio registry, does a clean global install of `@toolbx/cli`, and runs the real
user journeys (upstream tool calls and the custom-tool import → list → run path):

```bash
bash scripts/verify-publish.sh   # expect: ✓ PUBLISHED SHAPE VERIFIED
npm login
pnpm build
pnpm -r publish --access public
```

`pnpm -r publish` walks the workspace in dependency order and rewrites the internal
`workspace:^` refs to real version ranges. If your npm account has 2FA on writes,
add `--otp=<code>`.

## Renaming the packages

The published names are centralized, so a future rename (e.g. to a dedicated org
scope) is a small, mechanical change:

1. **`packages/core/src/clients/toolbx-command.ts`** — `TOOLBX_NPX_PACKAGE` is
   the single source of the name clients are wired with (`npx -y <name> serve`).
2. **The four `package.json` `name` fields** (`apps/cli`, `packages/core`,
   `packages/mcp-gateway`, `packages/custom-tools`) and the internal
   `dependencies` keys that reference them.
3. **Imports** — every `from '@toolbx/*'` specifier in source/tests
   (`grep -rn '@toolbx/'`), plus the `README.md` / `CLAUDE.md` examples.

After renaming: delete `dist/` + `tsconfig.tsbuildinfo` (composite incremental
builds must be cleaned), `pnpm install`, `pnpm build`, then
`bash scripts/verify-publish.sh`. The client-snippet snapshot test updates to the
new name — review the diff.
