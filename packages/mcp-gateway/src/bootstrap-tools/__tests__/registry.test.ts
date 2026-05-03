import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { createBootstrapToolRegistry, type BootstrapTool } from '../registry.js';

function descriptor(name: string, description?: string): Tool {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
}

function makeTool(name: string): BootstrapTool {
  return {
    descriptor: descriptor(name),
    invoke(args) {
      void args;
      return { content: [{ type: 'text', text: name }] };
    },
  };
}

describe('createBootstrapToolRegistry', () => {
  it('starts empty', () => {
    const registry = createBootstrapToolRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.find('toolbox__nope')).toBeUndefined();
  });

  it('lists added tool descriptors and finds them by exposed name', () => {
    const registry = createBootstrapToolRegistry();
    const a = makeTool('toolbox__a');
    const b = makeTool('toolbox__b');
    registry.add(a);
    registry.add(b);

    expect(registry.list().map((t) => t.name)).toEqual(['toolbox__a', 'toolbox__b']);
    expect(registry.find('toolbox__a')).toBe(a);
    expect(registry.find('toolbox__b')).toBe(b);
  });

  it('replaces an existing entry when add() is called twice with the same name', () => {
    const registry = createBootstrapToolRegistry();
    const v1 = makeTool('toolbox__same');
    const v2: BootstrapTool = {
      descriptor: descriptor('toolbox__same', 'second'),
      invoke(args): CallToolResult {
        void args;
        return { content: [{ type: 'text', text: 'v2' }] };
      },
    };
    registry.add(v1);
    registry.add(v2);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.description).toBe('second');
    expect(registry.find('toolbox__same')).toBe(v2);
  });
});
