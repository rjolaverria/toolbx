import { describe, expect, it } from 'vitest';

import {
  importTool,
  parseToolMetadata,
  ToolImportError,
  ToolMetadataParseError,
} from '../index.js';

describe('@toolbox/custom-tools barrel', () => {
  it('re-exports the metadata parser surface', () => {
    expect(typeof parseToolMetadata).toBe('function');
    expect(typeof ToolMetadataParseError).toBe('function');
  });

  it('re-exports the tool importer surface', () => {
    expect(typeof importTool).toBe('function');
    expect(typeof ToolImportError).toBe('function');
  });
});
