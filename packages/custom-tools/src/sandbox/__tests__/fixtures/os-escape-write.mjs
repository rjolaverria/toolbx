// Deliberately import-using, to exercise the OS sandbox boundary directly (not
// the harness purity seal). Reports whether a write to the parent-chosen target
// was blocked by the kernel. Not a custom tool — only used by the OS-boundary
// integration test.
import * as fs from 'node:fs';

process.channel?.ref();
process.once('message', (msg) => {
  let write;
  try {
    fs.writeFileSync(msg.target, 'escaped');
    write = 'ALLOWED';
  } catch (error) {
    write = `BLOCKED:${error.code}`;
  }
  process.send({ write });
  process.exit(0);
});
