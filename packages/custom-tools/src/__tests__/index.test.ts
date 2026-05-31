import { describe, expect, it } from 'vitest';

import { parseToolMetadata, ToolMetadataParseError } from '../index.js';

describe('@toolbox/custom-tools barrel', () => {
  it('re-exports the metadata parser surface', () => {
    expect(typeof parseToolMetadata).toBe('function');
    expect(typeof ToolMetadataParseError).toBe('function');
  });
});
