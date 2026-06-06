// Deliberately import-using, to exercise the OS sandbox read boundary directly
// (not the harness purity seal). Reports whether a read of the parent-chosen
// target was blocked by the kernel. Not a custom tool — only used by the
// OS-boundary integration test.
import * as fs from 'node:fs';

process.channel?.ref();
process.once('message', (msg) => {
  let read;
  try {
    fs.readFileSync(msg.target, 'utf8');
    read = 'ALLOWED';
  } catch (error) {
    read = `BLOCKED:${error.code}`;
  }
  process.send({ read });
  process.exit(0);
});
