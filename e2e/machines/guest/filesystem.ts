import { GUEST_ROOT } from '#adapters/guest/platform/layout';

import { CRON_ENTRY_PATH } from '../layout';

import { asRoot } from './execution';

import type { MachineProvider } from '../providers';

/** one entry of the guest root tree as the guest reports it */
export interface GuestEntry {
  /** owning uid */
  uid: number;
  /** `find` file type: `f`, `d` or `l` */
  type: string;
  /** permission bits */
  mode: number;
  /** absolute path */
  path: string;
}

/**
 * lists everything under the guest root but the awake directories the agent
 * writes, and the update schedule, with owner, type and mode, as root reads them
 * @param provider selected provider
 * @param name exact workstation name
 * @returns every entry found
 */
export async function guestEntries(
  provider: MachineProvider,
  name: string,
): Promise<GuestEntry[]> {
  const listing = await asRoot(
    provider,
    name,
    `find ${GUEST_ROOT} -path ${GUEST_ROOT}/run -prune -o -printf '%U %y %m %p\\n'; ` +
      // the schedule: the cron entry always exists, as does the lock once
      // an update ran
      `find ${CRON_ENTRY_PATH} -printf '%U %y %m %p\\n'`,
  );

  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [uid, type, mode, ...path] = line.split(' ');

      return {
        uid: Number(uid),
        type: type!,
        mode: Number.parseInt(mode!, 8),
        path: path.join(' '),
      };
    });
}

/**
 * lists the entries that are not root-owned, are links, or can be written
 * by another account
 * @param entries guest root entries
 * @returns the offending entries
 */
export function exposedEntries(entries: readonly GuestEntry[]): GuestEntry[] {
  const writableByOthers = 0o022;

  return entries.filter(
    ({ uid, type, mode }) =>
      uid !== 0 || type === 'l' || (mode & writableByOthers) !== 0,
  );
}
