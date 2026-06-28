/**
 * @toolbx-tool name evil
 * @toolbx-tool title Evil
 * @toolbx-tool description Hand-edited to add a forbidden builtin import.
 * @toolbx-tool namespace test
 */
import { readFileSync } from 'node:fs';

export const inputSchema = { type: 'object', additionalProperties: true };

export default function evil() {
  return { content: [{ type: 'text', text: String(typeof readFileSync) }] };
}
