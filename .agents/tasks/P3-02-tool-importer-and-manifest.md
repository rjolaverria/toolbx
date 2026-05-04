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
  - Generates a manifest JSON matching SPECS §6.3 schema (including `permissions` placeholder defaults).
  - Updates the central tool manifest list at `~/.config/toolbox/tools/manifest.json`.
- Refuses to import a tool whose namespace + name collides with an existing custom tool unless `--force`.

## Acceptance criteria

- Importing the SPECS §6.2 example produces the manifest in §6.3 (modulo the runtime-detected version field, if any).
- Imported tools are stored under the `toolbox` directory, never under a path containing the `tlbx` alias (per SPECS §6.2 note).
- Collisions with proxied namespaced tools are reported as errors.

## Out of scope

- Bundling / transpiling the imported file (Phase 1+ pulls it in via a runtime loader).
- Permission inference — defaults are minimal; the user reviews them in P2 / CLI.

## Definition of done

- Acceptance criteria hold.
- Tests cover the happy path, collision detection, and missing-export errors.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test:run` all pass.
- Task committed and the P3-02 checkbox in `.agents/TASKS.md` is updated with the closing commit hash.
