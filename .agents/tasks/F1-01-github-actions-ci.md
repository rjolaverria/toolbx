# F1-01 — GitHub Actions CI workflow

**Milestone**: Phase 1 follow-ups
**SPECS references**: none directly — closes a tooling gap surfaced by the Phase 1 review.

## Goal

Run the same gates the pre-commit hook runs locally on every PR and on every push to `main`, so shared branches cannot regress without the failure being visible to reviewers.

## Deliverables

- `.github/workflows/ci.yml` with one workflow triggered on `pull_request` and `push: branches: [main]`. The workflow runs the following jobs (parallel where independent, ordered where required):
  - `setup` — checks out the repo, installs pnpm, sets up Node, runs `pnpm install --frozen-lockfile`, caches the pnpm store.
  - `typecheck` — `pnpm typecheck`.
  - `lint` — `pnpm lint`.
  - `format` — `pnpm format:check`.
  - `test` — `pnpm test:run`.
  - `integration` — `pnpm test:integration` (depends on `test`; can run in the same job if the integration suite is fast enough).
- Version pinning strategy (since `engines.node` and `engines.pnpm` are minimum-supported ranges, not concrete versions):
  - **pnpm**: use the existing `packageManager` field in the root `package.json` (currently `pnpm@10.33.0`), via `pnpm/action-setup` with `version` omitted so it picks the field up automatically. This keeps a single source of truth.
  - **Node**: add a `.nvmrc` at the repo root pinning a concrete version inside the `engines.node` range (e.g. `22`), and configure `actions/setup-node` with `node-version-file: '.nvmrc'`. The `engines` range stays as the minimum-supported declaration; `.nvmrc` is what CI and local `nvm use` consume. Bumping either value goes through a separate task.
- Cache pnpm's content-addressed store between runs, keyed on `pnpm-lock.yaml`.

## Acceptance criteria

- Pushing a branch with a deliberate type error fails the `typecheck` job and blocks merge.
- Pushing a branch with a Prettier-violating change fails the `format` job and blocks merge.
- Pushing a branch with a failing test fails the `test` job and blocks merge.
- A clean push to a feature branch turns every job green within five minutes on the GitHub-hosted runner.
- The workflow file is the single source of truth for CI — no other workflow files are added by this task.

## Out of scope

- Cross-platform matrix (macOS / Windows). Phase 1 ships Linux-only CI; cross-platform is a future task if and when it matters.
- Release / publish workflows.
- Coverage threshold enforcement — that is F1-04, which depends on this task landing first.

## Definition of done

- Acceptance criteria hold against a real PR.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and `pnpm test:integration` are all green in CI.
- Task committed and the F1-01 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
