// Reports its own PID over IPC, then hangs forever. Used by the OS-boundary
// integration test to verify the sandboxed process tree is killed (the reported
// PID is the Node process under the bash → sandbox-exec wrapper). Not a custom
// tool.
process.channel?.ref();
process.once('message', () => {
  process.send({ pid: process.pid });
  setInterval(() => {}, 1 << 30);
});
