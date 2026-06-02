# P3-06 — OS-level sandbox for custom tools

**Milestone**: Phase 3 — Custom JS/TS Tools
**SPECS references**: §6.6 (criterion 7: "Later add stronger sandboxing")

## Goal

Replace the best-effort in-process hardening shipped in P3-03 with a real OS-level
isolation boundary, so a determined adversarial custom tool cannot escape the sandbox.

## Background

P3-03 runs each custom tool in a per-call Node **child process** with best-effort,
in-process hardening: pure (import-free) tools, runtime imports re-validated before
load, `--disallow-code-generation-from-strings` (blocks `eval`/`Function`), sealed
`process` escape hatches (`getBuiltinModule`, `binding`, `_linkedBinding`, `dlopen`,
`kill`, `abort`), removed/nonce-authenticated IPC, codegen-free JSON-Schema validation,
network/`fetch` gating, env allowlisting (with Node-control vars stripped), per-tool
timeout (SIGKILL), and audit logging with secret redaction.

These close every concrete vector raised in review, but in-process containment of
arbitrary code is fundamentally porous (new Node internals, resource exhaustion,
prototype pollution of the harness, etc.). P3-03 deliberately chose a **child process**
(not a worker thread) so an OS sandbox can wrap the spawn with no rewrite.

## Leading candidate

**Anthropic `sandbox-runtime` (`srt`)** — <https://github.com/anthropic-experimental/sandbox-runtime>.
OS-level process isolation (macOS `sandbox-exec`, Linux `bubblewrap`); usable as a
library (`SandboxManager.wrapWithSandbox`) to wrap each tool's child process, or via the
`srt` CLI. Enforces filesystem read/write restrictions + network allowlists that map
onto the existing `permissions` model.

Caveats to design around: Anthropic **experimental beta** (config format may move);
**macOS + Linux only, no Windows**; Linux requires bubblewrap/socat/ripgrep installed.
It covers FS + network isolation but **not** timeouts, audit logging, or secret
redaction — those remain in ToolBox and are complementary.

## Deliverables (sketch — refine when picked up)

- Wrap the P3-03 child spawn with `srt` (or an equivalent OS sandbox) when available,
  falling back to the in-process hardening (with a clear capability warning) when the
  platform/tooling is unsupported.
- Map `permissions` (network/filesystem/env) onto the sandbox's allowlists.
- Tests: a tool that reaches a builtin via a novel in-process trick is contained by the
  OS boundary even if the in-process seal misses it.

## Out of scope

- Reworking the P3-03 permission model or tool format.

## Notes

This task was filed from P3-03's roborev review, which repeatedly surfaced in-process
escape vectors — the expected signal that genuine isolation needs an OS boundary. The
recurring "backfill missing `timeoutMs`" review finding is intentionally **not** carried
here: it is declined under the repo's pre-release no-backward-compatibility policy.
