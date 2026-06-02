export const inputSchema = { type: 'object', additionalProperties: true };

export default function hangs() {
  return new Promise(() => {
    // never resolves — the runner must kill the process on timeout
  });
}
