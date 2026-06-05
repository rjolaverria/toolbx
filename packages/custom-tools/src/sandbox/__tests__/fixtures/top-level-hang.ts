// A tool whose module-level evaluation never completes (top-level await on a
// never-resolving promise). Used to prove that describe-mode schema resolution —
// which imports the module — is bounded by the per-tool timeout and SIGKILL,
// so a pathological tool cannot hang the gateway at exposure time.
export const inputSchema = { type: 'object', additionalProperties: true };

await new Promise<void>(() => {
  // never resolves — module evaluation hangs here
});

export default function topLevelHang() {
  return { content: [{ type: 'text', text: 'unreachable' }] };
}
