import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// guest kernel: imports only Node built-ins and other guest code. Two readings
// tell the governor what a wall clock alone cannot: the kernel's boot id
// changes on a cold boot only, and the uptime counts the guest's own running
// time, so a snapshot resume moves the wall clock further than the uptime

const MS_PER_SECOND = 1000;

/** what the kernel reports about this boot and its running time */
export interface MachineClock {
  /** the kernel's id of the current boot; a resumed snapshot keeps it */
  bootId: string;
  /** milliseconds the guest has run since the boot, not counting time it was frozen */
  uptimeMs: number;
}

/**
 * reads the boot id and the uptime
 * @param procRoot where the process table is
 * @returns the reading, or nothing where the kernel offers none
 */
export async function readMachineClock(
  procRoot = '/proc',
): Promise<MachineClock | undefined> {
  try {
    const [bootId, uptime] = await Promise.all([
      readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8'),
      readFile(join(procRoot, 'uptime'), 'utf8'),
    ]);
    const seconds = Number.parseFloat(uptime.split(' ')[0] ?? '');
    const id = bootId.trim();

    return id !== '' && Number.isFinite(seconds) && seconds >= 0
      ? { bootId: id, uptimeMs: Math.round(seconds * MS_PER_SECOND) }
      : undefined;
  } catch {
    return undefined;
  }
}
