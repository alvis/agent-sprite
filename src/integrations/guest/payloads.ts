import { GUEST_ROOT } from '#guest/guest-root';

import { writeGuestFile } from './files.js';
import { payloadMode, readGuestPayload } from './payloads/assets.js';

import type { GuestChannel } from '#drivers/guest-channel';

export {
  compiledPayloads,
  guestPayloadFrame,
  payloadUrl,
  readGuestPayload,
} from './payloads/assets.js';

/**
 * deploys a bundled asset through the current guest transaction
 * @param guest target guest
 * @param filename fixed compiled asset name, deployed with its one table mode
 */
export async function deployGuestPayload(
  guest: GuestChannel,
  filename: string,
): Promise<void> {
  await writeGuestFile(guest, {
    path: `${GUEST_ROOT}/${filename}`,
    contents: await readGuestPayload(filename),
    mode: payloadMode(filename),
  });
}
