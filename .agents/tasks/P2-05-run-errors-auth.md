# P2-05 — `tlbx run` auth, errors, and remediation

**Milestone**: Phase 2 — CLI Tool Execution
**SPECS references**: §4.6.2, §5.5, §5.6 (criteria 7, 8, 9)

## Goal

Ensure `tlbx run` reports failures in a way that is actionable for humans and deterministic for agents.

## Deliverables

- Error mapping for:
  - usage errors,
  - invalid JSON,
  - missing config,
  - daemon startup/readiness failure,
  - unknown server/tool,
  - disabled server/tool,
  - bearer `tokenEnv` missing from daemon environment,
  - OAuth required/expired,
  - timeout,
  - upstream tool failure.
- Remediation text:
  - unknown tools show nearby matches,
  - invalid JSON recommends `--example > input.json`,
  - disabled tools name the enable command,
  - bearer auth explains export + `tlbx stop` + retry,
  - OAuth names `tlbx auth login <server>`,
  - daemon failures name `tlbx doctor` and the daemon log path.
- Browser safety: `tlbx run` never launches a browser implicitly.
- JSON output errors use stable machine-readable codes.

## Acceptance criteria

- OAuth-required and OAuth-expired failures exit nonzero and recommend `tlbx auth login <server>`.
- Bearer missing-env failures explain that the daemon must be restarted with the variable in its environment.
- A reused long-lived daemon that started without the bearer env var still reports the restart remediation after the user exports the variable in a later shell; `tlbx run` must not imply that export plus immediate retry is enough.
- Disabled tools are not callable even if they are revealed.
- Every error mode keeps diagnostics on stderr unless `--output json` is emitting a structured error body.
- Tests prove no code path from `tlbx run` calls the browser-opening OAuth flow.

## Out of scope

- Automatically running OAuth login from `tlbx run`.
- Interactive prompts.

## Definition of done

- Acceptance criteria hold.
- Tests cover all mapped error families, the reused-daemon stale-env bearer case, and JSON error output.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P2-05 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
