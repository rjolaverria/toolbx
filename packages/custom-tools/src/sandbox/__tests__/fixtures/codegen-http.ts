export const inputSchema = { type: 'object', additionalProperties: true };

export default async function codegenHttp() {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = Function('return import("node:http")') as () => Promise<{ request: unknown }>;
  const http = await fn();
  return { content: [{ type: 'text', text: typeof http.request }] };
}
