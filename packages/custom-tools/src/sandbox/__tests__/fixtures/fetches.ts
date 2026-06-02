export const inputSchema = { type: 'object', additionalProperties: true };

export default async function fetches() {
  const res = await fetch('https://example.com');
  return { content: [{ type: 'text', text: String(res.status) }] };
}
