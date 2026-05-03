/**
 * Canonical exposed names for the five Phase 1 progressive-disclosure
 * bootstrap tools. Defining them in one place means callers (`reveal_tools`,
 * `hide_tools`, runtime wiring in M4-07) all guard against the same list, and
 * the M4-05 implementations can slot in without renaming anything.
 *
 * The same five-name list is hard-coded in
 * `packages/core/src/disclosure/__tests__/session-visibility.test.ts`.
 * `@toolbox/core` cannot import from `@toolbox/mcp-gateway` (wrong dependency
 * direction), so the duplication stays — both lists must agree by convention.
 */

export const SEARCH_TOOLS_NAME = 'toolbox__search_tools';
export const REVEAL_TOOLS_NAME = 'toolbox__reveal_tools';
export const HIDE_TOOLS_NAME = 'toolbox__hide_tools';
export const LIST_AVAILABLE_SERVERS_NAME = 'toolbox__list_available_servers';
export const LIST_REVEALED_TOOLS_NAME = 'toolbox__list_revealed_tools';

export const BOOTSTRAP_TOOL_NAMES: readonly string[] = [
  SEARCH_TOOLS_NAME,
  REVEAL_TOOLS_NAME,
  HIDE_TOOLS_NAME,
  LIST_AVAILABLE_SERVERS_NAME,
  LIST_REVEALED_TOOLS_NAME,
];
