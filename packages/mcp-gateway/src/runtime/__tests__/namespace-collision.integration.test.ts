import { detectCollisions, type NamespaceOptions } from '@rjolaverria/toolbox-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COLLIDING_FIXTURE,
  createIntegrationHarness,
  makeIntegrationConfig,
  startHarness,
} from './__fixtures__/integration-helpers.js';

const harness = createIntegrationHarness();

afterEach(async () => {
  await harness.cleanup();
});

const NAMESPACING: NamespaceOptions = { separator: '__', format: 'server__tool' };

describe('gateway namespace collision reporting', () => {
  it('reports a collision via detectCollisions when two upstreams produce the same exposed name', async () => {
    // Two upstream servers that, under the `server__tool` format, both
    // produce the exposed name `parent____do`:
    //   - server `parent_`  + tool `_do`   → `parent_` + `__` + `_do`  = `parent____do`
    //   - server `parent`   + tool `__do`  → `parent`  + `__` + `__do` = `parent____do`
    // Server names can't themselves contain `__` (schema-rejected), so the
    // realistic collision shape is an upstream that returns a tool name
    // containing the separator. The fixture lets us pick that name per
    // spawn via TOOLBOX_FIXTURE_TOOL_NAME.
    const config = makeIntegrationConfig({
      servers: {
        parent_: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [COLLIDING_FIXTURE],
          env: { TOOLBOX_FIXTURE_TOOL_NAME: '_do' },
        },
        parent: {
          type: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [COLLIDING_FIXTURE],
          env: { TOOLBOX_FIXTURE_TOOL_NAME: '__do' },
        },
      },
    });

    const { runtime } = await startHarness({ config, harness });

    // Both upstreams are connected. Their tool sets, ungrouped by exposed
    // name, are what doctor's collision check consumes. Reconstruct the
    // shape from the live registry — that's the surface a future runtime-
    // level collision-strategy enforcement (config.namespacing.collisionStrategy)
    // would inspect too.
    const tools = runtime.toolRegistry.list();
    const toolsByServer = tools.reduce<Record<string, string[]>>((acc, t) => {
      const bucket = acc[t.serverName] ?? [];
      bucket.push(t.upstreamName);
      acc[t.serverName] = bucket;
      return acc;
    }, {});

    expect(toolsByServer).toEqual({
      parent_: ['_do'],
      parent: ['__do'],
    });

    const collisions = detectCollisions(toolsByServer, NAMESPACING);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.exposedName).toBe('parent____do');
    const sources = collisions[0]?.sources ?? [];
    expect(sources).toEqual(
      expect.arrayContaining([
        { serverName: 'parent_', upstreamName: '_do' },
        { serverName: 'parent', upstreamName: '__do' },
      ]),
    );
  }, 15_000);
});
