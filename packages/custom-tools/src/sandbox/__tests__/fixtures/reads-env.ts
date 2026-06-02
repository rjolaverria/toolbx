export const inputSchema = { type: 'object', additionalProperties: true };

export default function readsEnv() {
  return { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env)) }] };
}
