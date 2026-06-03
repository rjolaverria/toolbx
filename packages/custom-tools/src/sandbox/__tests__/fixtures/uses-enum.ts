enum Mode {
  On,
  Off,
}

export const inputSchema = { type: 'object', additionalProperties: true };

export default function usesEnum() {
  return { content: [{ type: 'text', text: `mode=${Mode.Off}` }] };
}
