import { z } from 'zod';

/**
 * Persisted snapshot of the tool registry. Written by `@toolbox/mcp-gateway`'s
 * runtime whenever the visible tool set changes; read by CLI commands that
 * need to browse the tool inventory without starting the gateway.
 *
 * The `tool` payload is intentionally `unknown` — we re-validate the cache at
 * read time, but treat the cached `Tool` objects as opaque MCP shapes so a
 * future SDK addition (new optional field on `Tool`) does not invalidate
 * caches written by an older ToolBox.
 */

const CachedToolSchema = z
  .object({
    exposedName: z.string().min(1),
    serverName: z.string().min(1),
    upstreamName: z.string().min(1),
    tool: z.looseObject({
      name: z.string().min(1),
      description: z.string().optional(),
      title: z.string().optional(),
      inputSchema: z.unknown().optional(),
    }),
  })
  .strict();

export const ToolCacheFileSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.iso.datetime(),
    tools: z.array(CachedToolSchema),
  })
  .strict();

export type ToolCacheFile = z.infer<typeof ToolCacheFileSchema>;
export type CachedTool = z.infer<typeof CachedToolSchema>;
