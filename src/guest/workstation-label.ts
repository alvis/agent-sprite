import { GUEST_ROOT } from './guest-root.js';

/** the file whose `PRETTY_HOSTNAME` the agent reads as the human-readable name of the environment it runs in */
export const MACHINE_INFO_PATH = '/etc/machine-info';

/** the permission bits of the machine information file and of the name record: readable by every account, written by root alone */
export const WORKSTATION_LABEL_MODE = 0o644;

/** the key of the machine information file that holds the human-readable host name */
export const MACHINE_INFO_LABEL_KEY = 'PRETTY_HOSTNAME';

/** root-owned record of the workstation name on the persistent guest root, from which a provider that rebuilds its root filesystem on boot restores the machine information file */
export const WORKSTATION_NAME_RECORD = `${GUEST_ROOT}/workstation-name`;

const LABEL_LINE = new RegExp(`^\\s*${MACHINE_INFO_LABEL_KEY}\\s*=`);

/**
 * sets the human-readable host name in the contents of a machine information
 * file, keeping every other line and replacing any earlier label, so applying
 * it again to its own result changes nothing
 * @param existing current file contents, empty when the file does not exist
 * @param name workstation name, a lowercase DNS label that needs no quoting
 * @returns the file contents with the label as its last line
 */
export function withWorkstationLabel(existing: string, name: string): string {
  const kept = existing
    .split('\n')
    .filter((line) => line !== '' && !LABEL_LINE.test(line));

  const label = `${MACHINE_INFO_LABEL_KEY}=${name}`;

  return `${[...kept, label].join('\n')}\n`;
}
