export const inputSchema = {
  type: 'object',
  properties: { who: { type: 'string' } },
  required: ['who'],
  additionalProperties: false,
};

export default function returns(input: { who: string }) {
  return { content: [{ type: 'text', text: `Hello ${input.who}` }] };
}
