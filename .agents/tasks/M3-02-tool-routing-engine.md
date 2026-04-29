# M3-02 — Tool routing engine

**Milestone**: 3 — Proxy Routing
**README references**: §2.3, §4.6, §4.8 (criterion 7), §7 (Milestone 3)

## Goal

The single function the downstream `tools/call` handler delegates to. It owns: looking up the tool, choosing the upstream session, forwarding the call, and returning a typed routing result. This isolates routing decisions from MCP protocol plumbing in M2-05.

## Deliverables

- `packages/core/src/proxy/route.ts` exporting `routeToolCall({ exposedName, args, registry, sessions })` returning a discriminated result:
  - `{ kind: 'ok', result }`
  - `{ kind: 'unknown_tool' }`
  - `{ kind: 'server_unavailable', server, status }`
  - `{ kind: 'invalid_args', issues }`
  - `{ kind: 'upstream_error', server, error }`
- `packages/core/src/proxy/registry-view.ts` — read-only view of the tool registry the router uses (so the router does not depend on the live registry implementation).
- M2-05's handler becomes a thin adapter that converts `RouteResult` into MCP-protocol responses.

## Acceptance criteria

- The router never throws on the call paths above; it always returns a discriminated result.
- It selects the correct upstream session for any exposed name produced by M3-01.
- It refuses to call a tool whose server is currently `disabled`, `error`, `auth_required`, `auth_expired`, or `stopped`, returning `server_unavailable`.

## Out of scope

- Timeout and retry policy (M3-03).
- Progressive disclosure gating (M4-07).

## Definition of done

- Acceptance criteria hold.
- Unit tests cover all five `kind` branches with fixture sessions and registries.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the M3-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
