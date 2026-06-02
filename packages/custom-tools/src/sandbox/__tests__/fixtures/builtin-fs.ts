export const inputSchema = { type: 'object', additionalProperties: true };

export default function builtinFs() {
  const proc = process as unknown as { getBuiltinModule(id: string): unknown };
  const fs = proc.getBuiltinModule('node:fs');
  return { content: [{ type: 'text', text: typeof fs }] };
}
