/**
 * @toolbx-tool name greet
 * @toolbx-tool title Greet
 * @toolbx-tool description Greets the named person.
 * @toolbx-tool namespace personal
 */
export const inputSchema = {
  type: 'object',
  properties: { who: { type: 'string' } },
  required: ['who'],
  additionalProperties: false,
};

export default function greet(input: { who: string }) {
  return { content: [{ type: 'text', text: `Hello ${input.who}` }] };
}
