import { COMPONENT_CATALOG_FILE, componentCatalog } from '#core/guest-catalogs';
import { GUEST_ROOT } from '#guest/guest-root';

import { writeGuestFile } from '../guest.js';

import { CATALOG_FILE_MODE } from './payloads/assets.js';

import type { ComponentSelection } from '#core/guest-catalogs';
import type { GuestChannel } from '#drivers/guest-channel';

/**
 * records the selected provider's accounts, the selected agent and the
 * selected network's installer, if it has one, where guest scripts read them
 * @param guest target guest
 * @param selection selected provider, agent and network
 */
export async function writeComponentCatalog(
  guest: GuestChannel,
  selection: ComponentSelection,
): Promise<void> {
  await writeGuestFile(guest, {
    path: `${GUEST_ROOT}/${COMPONENT_CATALOG_FILE}`,
    contents: `${JSON.stringify(componentCatalog(selection), null, 2)}\n`,
    mode: CATALOG_FILE_MODE,
  });
}
