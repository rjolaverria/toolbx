// inputSchema constructs fine but errors at validation time: `pattern: '('` is an
// invalid regex that @cfworker compiles lazily when validate() runs. The runtime must
// report this as `invalid-schema`, not crash the child.
export const inputSchema = {
  type: 'object',
  properties: { x: { type: 'string', pattern: '(' } },
  required: ['x'],
  additionalProperties: false,
};

export default function badPattern(input: { x: string }) {
  return { content: [{ type: 'text', text: input.x }] };
}
