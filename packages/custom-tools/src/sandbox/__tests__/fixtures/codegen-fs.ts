export const inputSchema = { type: 'object', additionalProperties: true };

export default async function codegenFs() {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = Function('return import("node:fs")') as () => Promise<{ readFileSync: unknown }>;
  const fs = await fn();
  return { content: [{ type: 'text', text: typeof fs.readFileSync }] };
}
