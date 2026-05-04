import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * In-memory registry of toolbox-owned bootstrap tools. Bootstrap tools are
 * not upstream tools — they live inside the gateway and implement
 * progressive-disclosure affordances (`toolbox__search_tools`,
 * `toolbox__reveal_tools`, etc., per SPECS §2.4).
 *
 * The registry is a thin shared seam between `tools/list` (which prepends
 * `list()` to the upstream tool listing) and `tools/call` (which dispatches
 * to `find()` before falling through to upstream routing). The MCP SDK only
 * accepts one `setRequestHandler` per request schema, so all bootstrap-tool
 * dispatch must thread through the existing handlers.
 *
 * Bootstrap tools surface failures inside `CallToolResult` (`isError: true`)
 * rather than throwing `McpError` — they're protocol-level affordances, not
 * fallible upstream calls.
 */

export interface BootstrapTool {
  /** MCP `Tool` descriptor exposed in `tools/list`. `name` is the exposed name. */
  readonly descriptor: Tool;
  /**
   * Handle an incoming `tools/call` for this tool's `descriptor.name`. Must
   * not throw for normal validation/runtime failures — return
   * `{ isError: true, content: [...] }` instead so the downstream client
   * sees a structured failure on the same channel as upstream tool errors.
   */
  invoke(args: unknown): Promise<CallToolResult> | CallToolResult;
}

export interface BootstrapToolRegistry {
  /** Add a bootstrap tool. Replaces an existing entry with the same name. */
  add(tool: BootstrapTool): void;
  /** All registered descriptors. Used by `tools/list` to prepend bootstrap tools. */
  list(): readonly Tool[];
  /** O(1) lookup. Returns `undefined` if no bootstrap tool owns this name. */
  find(exposedName: string): BootstrapTool | undefined;
}

export function createBootstrapToolRegistry(): BootstrapToolRegistry {
  const tools = new Map<string, BootstrapTool>();

  return {
    add(tool) {
      tools.set(tool.descriptor.name, tool);
    },
    list() {
      const out: Tool[] = [];
      for (const tool of tools.values()) {
        out.push(tool.descriptor);
      }
      return out;
    },
    find(exposedName) {
      return tools.get(exposedName);
    },
  };
}
