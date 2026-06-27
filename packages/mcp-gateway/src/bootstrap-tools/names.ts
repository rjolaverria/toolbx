/**
 * Canonical exposed names for the five Phase 1 progressive-disclosure
 * bootstrap tools. Defining them in one place means callers (`reveal_tools`,
 * `hide_tools`, runtime wiring in M4-07) all guard against the same list, and
 * the M4-05 implementations can slot in without renaming anything.
 *
 * The same five-name list is hard-coded in
 * `packages/core/src/disclosure/__tests__/session-visibility.test.ts`.
 * `@toolbx/core` cannot import from `@toolbx/mcp-gateway` (wrong dependency
 * direction), so the duplication stays — both lists must agree by convention.
 */

/**
 * `_meta` key stamped onto every bootstrap descriptor in `tools/list`. It marks
 * a tool as gateway-internal so control-plane consumers (e.g. `tlbx run`
 * discovery) can distinguish bootstrap tools from upstream tools by provenance
 * rather than by name. A real upstream server named `toolbx` can legitimately
 * expose a tool that namespaces to a bootstrap name when bootstrap tools are
 * disabled, and that tool must not be mistaken for a bootstrap entry.
 */
export const BOOTSTRAP_TOOL_META_KEY = 'toolbx/bootstrap';

export const SEARCH_TOOLS_NAME = 'toolbx__search_tools';
export const REVEAL_TOOLS_NAME = 'toolbx__reveal_tools';
export const HIDE_TOOLS_NAME = 'toolbx__hide_tools';
export const LIST_AVAILABLE_SERVERS_NAME = 'toolbx__list_available_servers';
export const LIST_REVEALED_TOOLS_NAME = 'toolbx__list_revealed_tools';

export const BOOTSTRAP_TOOL_NAMES: readonly string[] = [
  SEARCH_TOOLS_NAME,
  REVEAL_TOOLS_NAME,
  HIDE_TOOLS_NAME,
  LIST_AVAILABLE_SERVERS_NAME,
  LIST_REVEALED_TOOLS_NAME,
];
