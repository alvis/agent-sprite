import { GUEST_ROOT } from '#guest/guest-root';

import { guestFileExists, readGuestFile, writeGuestFile } from '../guest.js';

import type { GuestChannel } from '#drivers/guest-channel';

/** the file whose `PRETTY_HOSTNAME` the agent reads as the human-readable name of the environment it runs in */
const MACHINE_INFO_PATH = '/etc/machine-info';

/** the permission bits of the machine information file and of the name record: readable by every account, written by root alone */
const WORKSTATION_LABEL_MODE = 0o644;

/** the key of the machine information file that holds the human-readable host name */
const MACHINE_INFO_LABEL_KEY = 'PRETTY_HOSTNAME';

/** root-owned record of the workstation name on the persistent guest root, from which a provider that rebuilds its root filesystem on boot restores the machine information file */
const WORKSTATION_NAME_RECORD = `${GUEST_ROOT}/workstation-name`;

const LABEL_LINE = new RegExp(`^\\s*${MACHINE_INFO_LABEL_KEY}\\s*=`);

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
}

/**
 * sets the human-readable host name in the contents of a machine information
 * file, keeping every other line and replacing any earlier label, so applying
 * it again to its own result changes nothing
 * @param existing current file contents, empty when the file does not exist
 * @param name workstation name, a lowercase DNS label that needs no quoting
 * @returns the file contents with the label as its last line
 */
function withWorkstationLabel(existing: string, name: string): string {
  const kept = existing
    .split('\n')
    .filter((line) => line !== '' && !LABEL_LINE.test(line));

  const label = `${MACHINE_INFO_LABEL_KEY}=${name}`;

  return `${[...kept, label].join('\n')}\n`;
}
