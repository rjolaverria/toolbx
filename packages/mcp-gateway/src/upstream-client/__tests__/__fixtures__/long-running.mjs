#!/usr/bin/env node
// A non-MCP child process that never replies to initialize. Used to verify
// that disconnect() reliably terminates a long-running upstream child rather
// than leaving an orphan. The interval keeps the event loop alive until the
// parent kills us.
const interval = setInterval(() => {
  /* keep alive */
}, 1000);

process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit(0);
});
