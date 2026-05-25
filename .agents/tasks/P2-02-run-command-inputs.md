# P2-02 — `tlbx run` command and JSON input modes

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §5.2, §5.3, §5.6 (criteria 1, 3, 4, 7)

## Goal

Add the `tlbx run` command that resolves a tool name, parses JSON input, and calls the daemon's MCP `tools/call` endpoint.

## Deliverables

- `apps/cli/src/commands/run.ts` registered as a top-level `tlbx run` command.
- Tool target parsing for both forms:
  - `tlbx run <server> <tool> ...` → `<server>__<tool>`
  - `tlbx run <exposedName> ...` → `<exposedName>`
- Mutually exclusive JSON input modes:
  - `--json <json>`
  - `--file <path>`
  - `--stdin`
- Empty input handling: tools with empty input schemas may omit all input modes; tools with non-empty schemas require one.
- MCP HTTP client wiring that uses P2-01's daemon helper, calls the daemon through the local Streamable HTTP MCP endpoint, and routes through `tools/call`.
- The daemon connection carries the local control-plane marker (§5.3) so progressive disclosure does not gate `tlbx run`: every enabled tool is callable by name regardless of the revealed set, even when `progressiveDisclosure.enabled=true`.
- Gateway-side honoring of the control marker: the downstream server recognizes the marker only on loopback connections and, for marked sessions, resolves `isDisclosureEnabled` to `false` and treats every enabled tool as visible in `tools/list` and `tools/call`. Unmarked sessions are unaffected and keep configured disclosure behavior.
- Validation that global disablement and namespacing behavior still match the gateway's `tools/call` result. A globally disabled tool stays uncallable from `tlbx run`.

## Acceptance criteria

- `tlbx run github create_issue --json '{"title":"Bug"}'` calls `github__create_issue`.
- `tlbx run github__create_issue --json '{"title":"Bug"}'` calls the same exposed tool.
- `--json`, `--file`, and `--stdin` reject combinations with a usage error.
- Invalid JSON exits nonzero before contacting the daemon.
- Tool calls go through the daemon's MCP endpoint, not a direct upstream client.
- A tool that is not revealed is still callable by name when `progressiveDisclosure.enabled=true`; a globally disabled tool is not.

## Out of scope

- Output rendering beyond a basic successful result (P2-03).
- Discovery subcommands (P2-04).
- Custom local tool runtime (Phase 3).

## Definition of done

- Acceptance criteria hold.
- Command tests cover target parsing, input parsing, mutual exclusion, invalid JSON, empty-input tools, and daemon client invocation.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
