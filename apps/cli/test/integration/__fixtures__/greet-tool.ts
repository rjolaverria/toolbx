/**
 * @toolbox-tool name greet
 * @toolbox-tool title Greet
 * @toolbox-tool description Greets the named person.
 * @toolbox-tool namespace personal
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
