# F1-23 — End-to-end OAuth integration tests + CI security gates

**Milestone**: Phase 1 follow-up (OAuth upstream auth, validation)
**SPECS references**: §4.6.2 (testing strategy summarized in design §6)
**Depends on**: F1-19, F1-20, F1-21

## Goal

The capstone test pass. Exercise every OAuth flow end-to-end against the fake auth server, prove the security properties in CI, and lock in the SPECS §4.6.2 acceptance criteria.

## Motivation

Per-task tests verify each module in isolation. This task ties them together: `tlbx server add-http` → real-shaped OAuth handshake → gateway runtime serves tools → expiry → recovery. It also installs the CI gates that keep the system safe over time.

## Deliverables

- **`tests/integration/oauth/` (or `packages/mcp-gateway/src/runtime/__tests__/oauth-e2e.integration.test.ts`)** — pick a location consistent with the existing M5-06 integration tests. The directory contains:
  - A reusable **fake OAuth authorization server** (extracted/promoted from F1-18 if not already shared) implementing the minimal RFC 8414/7591/6749/7636 surface used by the SDK.
  - A reusable **fake upstream MCP HTTP server** that validates `Authorization: Bearer <token>` matches an expected value before responding 200 to MCP requests.
  - End-to-end tests using both fixtures and a real gateway harness.

- **Tests:**
  1. **Add-http + tool call:** From a clean state, run `tlbx server add-http <name> --url <fake-mcp>` (probe → flow → write config → write token). Then start the gateway (`tlbx serve --stdio` style harness from M5-06), call a tool, assert the response.
  2. **Refresh-on-401:** Pre-seed an expired access token + valid refresh. Start gateway, call tool. Assert: one refresh round-trip happened (verify the fake auth server saw `grant_type=refresh_token`), tool call succeeded, tokenStore has new tokens.
  3. **Revoked refresh → auth_expired surface:** Pre-seed expired access + revoked refresh. Start gateway, call tool. Assert: tool call resolves with `isError: true` and the SPECS-prescribed message. Status registry shows `auth_expired`.
  4. **Recovery from auth_expired:** After test #3, simulate the user running `tlbx auth login` by writing fresh tokens to the tokenStore directly. Next tool call from the same downstream session succeeds; status transitions back to `connected`.
  5. **Cancellation during add-http:** Start `add-http`; while the browser-open stub is "thinking", send abort. Assert: config unchanged, tokenStore unchanged, exit code 2.
  6. **Discovery degradation:** Add-http with a probe target returning 500. Assert: config unchanged, exit code 4, no flow attempted.
  7. **Explicit `--auth oauth` path bypasses probe:** Same as test #1 but with explicit `--auth oauth`. Assert no probe HTTP request was made.

- **CI security gates:**
  - **`scripts/check-no-token-leaks.mjs`** (new) — scans `dist/` outputs and a captured runtime-log file for `Bearer [A-Za-z0-9-._~+/]+` matches and `"access_token":"[^"]+"` matches. Exits non-zero on any hit. Use a fast `ripgrep`-equivalent or plain regex over each file.

  - **`.github/workflows/ci.yml`** (modify): add a step after the test job:

    ```yaml
    - name: Token-leak check
      run: pnpm build && node scripts/check-no-token-leaks.mjs
    ```

  - **Loopback-only assertion** is already in F1-16's tests; no CI work needed beyond running the suite.

  - **Snapshot of CLI output sanity check:** the F1-19 snapshot tests already capture stdout/stderr; manually review the snapshots once for any accidental token bytes. Document this manual check in the task closure note in TASKS.md.

- **Coverage threshold bumps:** in `vitest.config.ts` (root), raise the `@toolbox/core` and `apps/cli` coverage floors by 2 points to capture the new auth code. Rationale: SPECS §6.4 (testing — CLAUDE.md says "Raising a floor is encouraged"). The increases must be earned by the new tests passing; don't merge if they fail.

- **`README.md`** or a new `docs/oauth.md` (one of them, depending on existing doc structure): a short user-facing section showing the happy path:
  ```text
  npx tlbx server add-http github --url https://api.githubcopilot.com/mcp/
  # Browser opens; you authenticate; the entry is registered.
  npx tlbx auth status               # see which servers have stored tokens
  npx tlbx auth login github         # re-authenticate when prompted
  ```

## Acceptance criteria

- All seven CLAUDE.md quality gates green, including the new integration tests.
- All seven test scenarios pass.
- The CI token-leak check is wired into the workflow and runs on every PR.
- The README quickstart includes the OAuth flow.
- Coverage thresholds reflect the new floor.

## Out of scope

- Real-keychain integration tests across the macOS/Windows/Linux matrix — manual pre-release smoke.
- End-to-end tests against real upstream OAuth servers (GitHub Copilot, etc.) — opt-in `pnpm test:e2e:live` script, not run in CI.
- Performance regression tests on the refresh-on-401 path.

## Definition of done

All seven CLAUDE.md quality gates pass; closing commit/PR referenced in TASKS.md. Manual review of CLI snapshots for token-byte leakage noted in the closing commit message.
