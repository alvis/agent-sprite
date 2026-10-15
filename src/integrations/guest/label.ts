import {
  MACHINE_INFO_PATH,
  WORKSTATION_LABEL_MODE,
  WORKSTATION_NAME_RECORD,
  withWorkstationLabel,
} from '#guest/workstation-label';

import { guestFileExists, readGuestFile, writeGuestFile } from '../guest.js';

import { withGuestTransaction } from './transaction.js';

import type { GuestChannel } from '#drivers/guest-channel';

/**
 * names the guest after its workstation, so the agent reports the workstation
 * name as its environment instead of the provider's hostname: the name goes
 * into the machine information file, root's and readable by every account,
 * keeping the file's other keys, and into a root-owned record on the guest
 * root, from which a provider that rebuilds its root filesystem on boot
 * restores that file. The agent reads the file when it starts, so the name
 * shows from its next start
 * @param guest target guest
 * @param name name of the workstation the guest belongs to
 */
export async function writeWorkstationLabel(
  guest: GuestChannel,
  name: string,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const existing = (await guestFileExists(guest, MACHINE_INFO_PATH))
      ? await readGuestFile(guest, MACHINE_INFO_PATH)
      : '';
    await writeGuestFile(guest, {
      path: WORKSTATION_NAME_RECORD,
      contents: `${name}\n`,
      mode: WORKSTATION_LABEL_MODE,
    });
    await writeGuestFile(guest, {
      path: MACHINE_INFO_PATH,
      contents: withWorkstationLabel(existing, name),
      mode: WORKSTATION_LABEL_MODE,
    });
  });
}
