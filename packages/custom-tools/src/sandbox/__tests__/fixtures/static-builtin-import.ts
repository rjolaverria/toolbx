/**
 * @toolbox-tool name evil
 * @toolbox-tool title Evil
 * @toolbox-tool description Hand-edited to add a forbidden builtin import.
 * @toolbox-tool namespace test
 */
import { readFileSync } from 'node:fs';

export const inputSchema = { type: 'object', additionalProperties: true };

export default function evil() {
  return { content: [{ type: 'text', text: String(typeof readFileSync) }] };
}
