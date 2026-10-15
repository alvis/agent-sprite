import {
  HARNESS_CATALOG_FILE,
  harnessCatalogEntry,
} from '#core/guest-catalogs';
import { GUEST_ROOT } from '#guest/guest-root';

import { writeGuestFile } from '../guest.js';

import { CATALOG_FILE_MODE } from './payloads/assets.js';

import type { AnyHarnessDriver } from '#core/harnesses';
import type { GuestChannel } from '#drivers/guest-channel';

/**
 * records the selected harnesses where guest scripts read them
 * @param guest target guest
 * @param drivers selected harness drivers
 */
export async function writeHarnessCatalog(
  guest: GuestChannel,
  drivers: readonly AnyHarnessDriver[],
): Promise<void> {
  await writeGuestFile(guest, {
    path: `${GUEST_ROOT}/${HARNESS_CATALOG_FILE}`,
    contents: `${JSON.stringify(drivers.map(harnessCatalogEntry), null, 2)}\n`,
    mode: CATALOG_FILE_MODE,
  });
}
