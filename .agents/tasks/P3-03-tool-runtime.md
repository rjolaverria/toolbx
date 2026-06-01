# P3-03 — Custom tool runtime with timeouts and permissions

**Milestone**: Phase 3 — Custom JS/TS Tools
**SPECS references**: §6.6, §6.7 (criteria 8, 9)

## Goal

Run an imported custom tool when it's called, with timeouts, audit logs, and a basic permissions model. Stronger sandboxing is deferred per SPECS §6.6.

## Deliverables

- `packages/custom-tools/src/sandbox/runner.ts` exporting `runTool(manifest, args)`:
  - Loads the tool source through a Node `worker_thread` (preferred) or child process.
  - Enforces the per-tool timeout from the manifest.
  - Validates that the loaded `inputSchema` export is actually a Zod schema (or compatible JSON Schema) at load time — P3-02 only confirms statically that a non-primitive `inputSchema` is exported, since it never evaluates the file; the runtime is the first point the schema value exists and can be checked. Reject the tool with a clear error if it is not.
  - Validates `args` against the tool's `inputSchema` before invocation.
  - Applies permissions: `network` (false → block `fetch`/`net`/`http(s)` by injecting throwing globals/agents), `filesystem` (false → wrap `fs` with throwing proxies), `env` (allowlist).
  - Emits an audit log entry per call: `{ tool, durationMs, outcome, errorCode? }`.
- Hides secrets from logs using the M0-02 logger redaction support (extend the logger if needed).

## Acceptance criteria

- A tool that returns a value within the timeout returns its result; a tool that hangs is killed and reports `timeout`.
- A tool with `network: false` cannot make outbound HTTP calls (verified by attempting `fetch` and asserting an error).
- A tool with `env: ['SLACK_BOT_TOKEN']` cannot read other env vars (verified via `process.env`).
- Audit logs never include the raw values of redacted env vars.

## Out of scope

- Strong sandboxing (e.g. V8 isolates, OS-level sandboxing) — deferred per SPECS §6.6.
- Resource limits beyond timeout (CPU / memory limits left for later).

## Definition of done

- Acceptance criteria hold.
- Tests use a fixture tool to exercise timeout, permission denial, and audit-log redaction.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-03 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
