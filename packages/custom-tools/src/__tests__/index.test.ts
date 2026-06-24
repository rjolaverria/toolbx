import { describe, expect, it } from 'vitest';

import {
  importTool,
  parseToolMetadata,
  redactSecrets,
  runTool,
  ToolImportError,
  ToolMetadataParseError,
} from '../index.js';

describe('@rjolaverria/toolbox-custom-tools barrel', () => {
  it('re-exports the metadata parser surface', () => {
    expect(typeof parseToolMetadata).toBe('function');
    expect(typeof ToolMetadataParseError).toBe('function');
  });

  it('re-exports the tool importer surface', () => {
    expect(typeof importTool).toBe('function');
    expect(typeof ToolImportError).toBe('function');
  });

  it('re-exports the runtime surface', () => {
    expect(typeof runTool).toBe('function');
    expect(typeof redactSecrets).toBe('function');
  });
});
