# F1-05 — Gateway-level integration tests

**Milestone**: Phase 1 follow-ups
**SPECS references**: §4.8

## Goal

Direct gateway integration tests already exist at `packages/mcp-gateway/src/runtime/__tests__/integration.test.ts` and `notifications.integration.test.ts` — they drive `createGatewayRuntime` + `createDownstreamHttpServer` against a real `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport`, using the `echo-server.mjs` stdio upstream fixture. They cover the HTTP-downstream happy path, bootstrap-tool wiring, and `tools/list_changed` notifications. They do **not** cover the stdio-downstream path, reconnect-after-crash, bearer-auth env resolution, or namespace-collision reporting. Extend the existing suite to fill those specific gaps, rather than starting a parallel suite. (The CLI integration suite at `apps/cli/test/integration/` exercises these paths transitively but isn't a substitute for direct gateway coverage.)

## Deliverables

- Extend the existing tests under `packages/mcp-gateway/src/runtime/__tests__/`. Add new files only when a scenario doesn't fit cleanly into an existing one. Re-use the existing `echo-server.mjs` fixture and the per-test cleanup pattern (`activeClients` / `activeServers` / `activeRuntimes` sets in `afterEach`).
- New scenario coverage to add:
  - **Stdio downstream happy path**: real upstream stdio fixture + downstream stdio server (`createDownstreamStdioServer`) driven by an MCP `Client` over `StdioClientTransport`. `initialize`, `tools/list`, `tools/call`, `notifications/tools/list_changed`. Today's HTTP-downstream tests already cover the equivalent over HTTP.
  - **Reconnect after upstream crash**: kill the upstream fixture mid-session; assert the gateway moves the server to `failed` then back to `connected` with a `tools/list_changed` notification when the fixture recovers.
  - **Bearer auth env var resolution**: HTTP upstream that requires `Authorization: Bearer $TOKEN`; assert the gateway resolves `${env:TOKEN}` and sends the header. Cover the missing-env-var case too — gateway must surface `auth_required`.
  - **Namespace collision**: two upstream servers producing the same exposed name; assert the registry reports the collision via the existing error type.
- No test depends on real network access — every upstream is a local fixture (extend `__fixtures__/` rather than inventing new fixture locations).
- Total integration suite runs in under 30 seconds on a developer laptop.

## Acceptance criteria

- Every new scenario is covered by at least one test that fails when the corresponding code path is regressed (verified by mutation: temporarily break the path, watch the test go red).
- The existing `integration.test.ts` and `notifications.integration.test.ts` continue to pass unmodified — or, if they need to move/split, the diff explains why.
- No test logic is duplicated between the existing suite and the new scenarios; shared setup lives in a `__fixtures__/` helper.
- `pnpm test:integration` is green locally and in CI.

## Out of scope

- Performance / load testing.
- Cross-process integration with daemon-backed `tlbx run` (Phase 2 territory).
- Replacing the CLI integration suite — that suite tests CLI plumbing on top of the runtime, which is still valuable.

## Definition of done

- Acceptance criteria hold.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and `pnpm test:integration` all pass.
- Task committed and the F1-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
