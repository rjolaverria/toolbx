# P3-02 — Custom tool importer and manifest generator

**Milestone**: Phase 3 — Custom JS/TS Tools
**SPECS references**: §6.2, §6.3, §6.7 (criteria 1, 3)

## Goal

Take a path to a `.ts` / `.js` file, validate its metadata and shape, copy it into the ToolBox tools directory, and write a manifest.

## Deliverables

- `packages/custom-tools/src/manifest/import.ts` exporting `importTool(sourcePath, options)`:
  - Calls P3-01 to parse metadata.
  - Verifies the file has a default-exported async function and an `inputSchema` Zod schema (or compatible JSON Schema).
  - Copies the file to `~/.config/toolbox/tools/<namespace>/<name>.<ext>` (per SPECS §6.2).
  - Generates a manifest JSON matching the SPECS §6.3 _shape_, with the two security-driven defaults below rather than the illustrative values shown in §6.3.
  - Updates the central tool manifest list at `~/.config/toolbox/tools/manifest.json`.
- Refuses to import a tool whose namespace + name collides with an existing custom tool unless `--force`.

### Manifest defaults on import

§6.3 shows a fully populated _example_ manifest; it is not the post-import default. To honour the security model (§6.6 #2 "require explicit enablement", §6.5's separate Enable step, principle 8 "explicit", and this task's out-of-scope note that permission inference is deferred), a freshly imported tool gets:

- `enabled: false` — the tool must be enabled explicitly later (P3-04 `tool enable`). §6.3's `enabled: true` is illustrative only.
- Minimal, locked-down permissions: `{ network: false, filesystem: false, env: [] }`. The user reviews and widens them in the CLI import preview (P3-04). §6.3's `network: true` / `env: ["SLACK_BOT_TOKEN"]` are illustrative only and are not auto-inferred.

## Acceptance criteria

- Importing the SPECS §6.2 example produces a manifest with the §6.3 field shape and the import defaults above (`enabled: false`, minimal permissions), the correct `exposedName` (`personal__send_slack_summary`), and an `entry` of `tools/personal/send_slack_summary.ts`.
- Imported tools are stored under the `toolbox` directory, never under a path containing the `tlbx` alias (per SPECS §6.2 note).
- Collisions with proxied namespaced tools (a custom-tool namespace equal to a configured upstream server name) are reported as errors.

## Out of scope

- Bundling / transpiling the imported file (Phase 1+ pulls it in via a runtime loader).
- Permission inference — defaults are minimal; the user reviews them in the CLI import flow.

## Definition of done

- Acceptance criteria hold.
- Tests cover the happy path, collision detection, and missing-export errors.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
