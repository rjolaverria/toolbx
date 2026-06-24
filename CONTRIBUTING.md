# Contributing to ToolBox

Thanks for hacking on ToolBox. This is a pnpm + Turborepo monorepo.

## Prerequisites

- **Node ≥ 22.7.0** (`.nvmrc` pins the version)
- **pnpm ≥ 10** — `corepack enable` then `corepack prepare pnpm@latest --activate`

## Getting set up

```bash
git clone https://github.com/rjolaverria/ToolBox.git
cd ToolBox
pnpm install
pnpm build        # Turbo-ordered build of all packages
```

Run the local CLI without installing it globally:

```bash
node apps/cli/dist/index.js --help
# or after `pnpm build`, link it:  pnpm --filter @toolbox/cli exec npm link
```

## Quality bar

Every change must pass the same gate CI runs:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:run
pnpm test:integration
```

The pre-commit hook auto-fixes ESLint + Prettier on staged files — never bypass
it with `--no-verify`.

## Repository layout

```
apps/cli                  — Commander CLI, produces the tlbx binary (@toolbox/cli)
packages/core             — config, registry, proxy, disclosure, namespacing, auth
packages/mcp-gateway      — MCP protocol layer (downstream server + upstream client)
packages/custom-tools     — custom-tool importer + on-disk child-process sandbox
```

`@toolbox/core` is the shared heart and must not depend on CLI-specific concerns.
See [`CLAUDE.md`](./CLAUDE.md) for conventions (TypeScript config, code style,
namespacing, the task workflow) and [`.agents/SPECS.md`](./.agents/SPECS.md) for
the full product spec.

## Packaging note

ToolBox publishes as four packages, not one bundle. The custom-tools sandbox
spawns a child-process harness and re-imports modules from disk, so the packages
must keep their real on-disk file layout — do not introduce a bundler that
inlines `@toolbox/custom-tools` into a single file. See
[`RELEASING.md`](./RELEASING.md) for how releases are cut.
