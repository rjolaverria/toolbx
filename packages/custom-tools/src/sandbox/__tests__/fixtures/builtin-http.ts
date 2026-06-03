export const inputSchema = { type: 'object', additionalProperties: true };

export default function builtinHttp() {
  const proc = process as unknown as { getBuiltinModule(id: string): unknown };
  const http = proc.getBuiltinModule('node:http');
  return { content: [{ type: 'text', text: typeof http }] };
}
