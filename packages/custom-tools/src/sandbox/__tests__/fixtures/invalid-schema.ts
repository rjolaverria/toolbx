// inputSchema is not a valid JSON Schema (a string is not compilable by Ajv),
// so the runtime must reject it with code 'invalid-schema'.
export const inputSchema = 'not a schema' as unknown;

export default function invalidSchema() {
  return { content: [] };
}
