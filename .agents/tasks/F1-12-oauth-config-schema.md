# F1-12 — OAuth config schema (`auth.storage` + `auth.type === 'oauth'`)

**Milestone**: Phase 1 follow-up (OAuth upstream auth, foundation)
**SPECS references**: §4.4 (Example config), §4.6.2 (Upstream OAuth 2.1 auth)
**Depends on**: —

## Goal

Add the two config-schema surfaces required by every other OAuth task: a new `auth: { type: 'oauth' }` variant on `ServerConfig` and a new top-level `auth.storage` field selecting the token-store backend. After this task lands, the example config in SPECS §4.4 parses cleanly and downstream tasks can rely on these types.

## Motivation

Every OAuth task that touches storage or upstream auth reads typed fields from this schema. Landing the schema first means every later task can `import` from `@toolbox/core` without conditional types or `as unknown as` casts. The schema is also the public contract for users editing `config.json` by hand, so it has to be right at IO boundaries (CLAUDE.md → "Use Zod only at IO boundaries").

## Deliverables

- **`packages/core/src/config/schema.ts`** — extend the existing schema:
  1. Add a new discriminated-union variant to the auth schema:

     ```ts
     export const OAuthAuthSchema = z.object({
       type: z.literal('oauth'),
     });
     ```

     Add it to the existing `AuthSchema` discriminated union alongside `NoneAuthSchema` and `BearerAuthSchema`. The `oauth` variant carries no fields in this task — DCR-issued `clientInformation`, scopes, etc. live in the TokenStore (F1-13), not in `config.json`.

  2. Add a new top-level optional field:

     ```ts
     export const TokenStorageSchema = z.discriminatedUnion('type', [
       z.object({ type: z.literal('keychain') }),
     ]);

     export const TopLevelAuthSchema = z.object({
       storage: TokenStorageSchema.optional(),
     });
     ```

     Wire it into the root config schema so the path is `config.auth.storage.type`. Default when omitted: `{ type: 'keychain' }`. Apply the default via `.transform()` or `.default()` so consumers always receive a resolved value — do not push the default into reading code.

  3. Update the exported `ServerConfig` discriminated union and root `ConfigSchema` types accordingly. Run `pnpm typecheck` and fix every callsite the new union variant breaks (mostly upstream-client and CLI — fail-fast switches need an `oauth` arm that throws `not implemented` for now; F1-14 / F1-21 fill them in).

- **`packages/core/src/config/__tests__/schema.test.ts`** — add tests:
  - Parsing an `oauth` server entry returns the expected typed object.
  - Parsing a config with `auth.storage` omitted resolves it to `{ type: 'keychain' }`.
  - Parsing a config with `auth.storage.type: 'unknown'` rejects with a clear Zod error path.
  - Round-trip: `parse(serialize(config))` is stable for a config that includes one of each `auth.type` variant.

- **`.agents/SPECS.md` §4.4 example config** — already updated (committed alongside the design in this milestone). Verify the file parses against the new schema as part of this task's tests.

## Acceptance criteria

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run` all pass.
- The SPECS §4.4 example config (including the new `auth.storage` field and the `github-copilot` server with `auth: { type: 'oauth' }`) parses through `ConfigSchema` in a test.
- Every `switch` on `auth.type` in the existing codebase has an `oauth` arm. Arms that don't yet have a real implementation throw `new Error('auth.type "oauth" not yet implemented (F1-XX)')` referencing the task that will fill them in — never silent fall-through.
- No changes to `apps/cli`, `packages/mcp-gateway` runtime behavior, beyond the placeholder throw-arms required to keep typecheck green.

## Out of scope

- `TokenStore` interface or any storage implementation (F1-13, F1-14).
- Discovery, callback server, provider, login orchestrator, CLI commands, gateway changes.
- Adding `@napi-rs/keyring` to `package.json` (lives in F1-14 with the keychain implementation).

## Definition of done

- All seven quality gates from CLAUDE.md "Task Workflow" pass.
- Task-completion note in `.agents/TASKS.md` points at the closing commit/PR.
- Self-review confirms no placeholder values in the schema (no `z.unknown()`, no `.optional()` where the design says required).
