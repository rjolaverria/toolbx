import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { SessionVisibility } from '@toolbox/core';

import type { BootstrapToolRegistry } from '../../bootstrap-tools/index.js';
import type { ToolRegistry } from '../../registry/index.js';
import type { DownstreamSession } from '../session.js';

import { requireReady } from './lifecycle.js';

export interface RegisterToolsListHandlerOptions {
  /**
   * Per-session revealed-tool tracker. When `isDisclosureEnabled` returns
   * `true`, the upstream tool list is filtered through `visibility.isVisible`
   * so only revealed names surface. Bootstrap tools are not affected — they
   * are prepended unconditionally and their names already report visible via
   * `visibility.isVisible` (callers wire `bootstrapToolNames` accordingly).
   */
  visibility?: SessionVisibility;
  /**
   * Resolves the live `progressiveDisclosure.enabled` flag at request time.
   * Reading per request lets M5-03's `tlbx config set` toggle take effect on
   * the next `tools/list` without rebuilding the runtime; the runtime fans a
   * `tools/list_changed` notification through `notifyAllSessionsToolsChanged`
   * so the new view is fetched.
   */
  isDisclosureEnabled?: () => boolean;
}

/**
 * Registers the `tools/list` handler.
 *
 * Disclosure off (M2-04 default) — returns every namespaced tool from every
 * connected, enabled upstream server, sorted by `(serverName, upstreamName)`
 * ascending.
 *
 * Disclosure on (M4-07) — returns the bootstrap tools plus the subset of
 * upstream tools currently visible to this session per `visibility`. With no
 * reveals, the listing is bootstrap-only.
 *
 * Bootstrap tools reserve their exposed names regardless of mode: any upstream
 * tool whose namespaced name collides with a bootstrap name (e.g. an upstream
 * server literally named `toolbox` exposing a tool that namespaces to
 * `toolbox__search_tools`) is dropped from the listing so it matches what
 * `tools/call` will actually dispatch — bootstrap always wins. Callers that
 * don't register any bootstrap tools pass an empty registry; the listing then
 * matches the previous upstream-only behaviour byte-for-byte.
 *
 * Pagination is intentionally not implemented; the tool registry is small
 * enough in Phase 1 that returning the full list per request is fine.
 */
export function registerToolsListHandler(
  server: Server,
  session: DownstreamSession,
  registry: ToolRegistry,
  bootstrap: BootstrapToolRegistry,
  options: RegisterToolsListHandlerOptions = {},
): void {
  const { visibility, isDisclosureEnabled } = options;

  server.setRequestHandler(ListToolsRequestSchema, () => {
    requireReady(session);
    const bootstrapTools = bootstrap.list();
    const reserved = new Set(bootstrapTools.map((tool) => tool.name));
    const disclosureOn = isDisclosureEnabled?.() === true;
    const upstreamTools = registry
      .list()
      .filter((entry) => !reserved.has(entry.exposedName))
      .filter((entry) => {
        if (!disclosureOn || visibility === undefined) {
          return true;
        }
        return visibility.isVisible(entry.exposedName);
      })
      .map((entry) => entry.tool);
    return {
      tools: [...bootstrapTools, ...upstreamTools],
    };
  });
}
