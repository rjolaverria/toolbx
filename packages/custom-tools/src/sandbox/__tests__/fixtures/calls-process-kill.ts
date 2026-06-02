export const inputSchema = { type: 'object', additionalProperties: true };

export default function callsProcessKill() {
  process.kill(process.ppid, 'SIGTERM');
  return { content: [{ type: 'text', text: 'killed' }] };
}
