import { z } from 'zod';

/**
 * Persisted record of a detached `tlbx serve --detach` process. Written by
 * the parent CLI once the child has been spawned, read by `tlbx stop` and by
 * subsequent `tlbx serve --detach` invocations to detect an already-running
 * daemon.
 *
 * The file is intentionally tiny — just enough to find the child by pid,
 * report it back to the user, and clean up afterwards. It is **not** an IPC
 * channel; the parent does not communicate with the child after spawn.
 */
export const ServeDaemonStateSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    mode: z.literal('http'),
    url: z.string().min(1).nullable(),
    logPath: z.string().min(1),
    startedAt: z.iso.datetime(),
  })
  .strict();

export type ServeDaemonState = z.infer<typeof ServeDaemonStateSchema>;
