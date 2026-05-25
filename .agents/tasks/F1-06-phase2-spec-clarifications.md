# F1-06 — Phase 2 spec clarifications

**Milestone**: Phase 1 follow-ups
**SPECS references**: §2.3, §2.4, §4.2, §4.4, §4.6, §6.2

## Goal

The Phase 1 review surfaced five ambiguities in `.agents/SPECS.md` that are tolerable today but will block or destabilize Phase 2 work. Each one needs a written decision in SPECS before Phase 2 contributors hit it. They all touch the same file, so consolidating into one task avoids merge churn — but each ambiguity is resolved with its own clearly-headed subsection so reviewers can comment on them independently.

## Deliverables

Edit `.agents/SPECS.md` to lock down each of the following. Where a decision is genuinely open, the deliverable is a short ADR-style block in SPECS that names the decision, the alternatives considered, and the reasoning — not just the bare answer.

1. **Progressive-disclosure session lifetime (§2.4).** Define what bounds a "session." Candidates: per-MCP-`initialize` call, per-downstream-transport-connection, per-client-process. The current implementation appears to bind it to the downstream session — write that down (or override it).
2. **`tlbx tools enable / disable` scope (§4.2).** Specify whether the flip is global (persisted in config), per-session (in-memory), or both with explicit precedence. Specify how the flip interacts with progressive disclosure (a disabled-but-revealed tool is what?).
3. **Config schema versioning + migration policy (§4.4).** The example shows `"version": 1`. Decide: how does ToolBox handle a config with an older `version` than the current binary expects? An unknown newer version? Define a one-paragraph migration story (forward-compat / hard-fail / migration helpers) and commit to it.
4. **Auth recovery flow (§4.6).** Today the gateway surfaces `auth_required` and `auth_expired` states. Specify how a user moves a server out of those states — what command, what UX, where credentials get persisted (config? keychain? env var only?). This is the bridge between Phase 1's polling and later CLI tool execution flows; without it, daemon-backed calls are under-specified.
5. **Custom-tool ↔ proxied-tool namespace collision rule (§2.3 / §6.2).** P3-02 says custom-tool collisions with proxied tools are errors, but §2.3 doesn't currently restrict this. Add the rule explicitly to §2.3 so it isn't first encountered as a P3 surprise.

## Acceptance criteria

- Each of the five subsections in SPECS contains a definite answer (not "TBD" or "to be decided"). If the answer is "we punt this to Phase 2 with the following constraint," that itself is a definite answer.
- Every Phase 2 task file is re-read after the SPECS edit, and any task that contradicts the new clarifications is updated in the same commit. (Expected diff: small or zero.)
- No code changes — SPECS edits and at most light task-file edits only.

## Out of scope

- Implementing any of the clarified behaviors. Each implementation belongs in its own task — likely Phase 2 or Phase 3 — once SPECS is locked.
- Resolving items that are already decided in SPECS but feel underspecified to the implementer's taste. This task is the five items above, not a general rewrite.

## Definition of done

- Acceptance criteria hold.
- A reviewer who has not seen the original feedback can read the diff and understand each decision in isolation.
- `pnpm format:check` passes (Markdown is Prettier-managed).
- Task committed and the F1-06 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
