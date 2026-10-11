import { writeGuestFile } from './files.js';
import { ROOT_SCRIPT_MODE, readGuestPayload } from './payloads/assets.js';

import type { Sprite } from '@fly/sprites';

export {
  compiledPayloads,
  guestPayloadFrame,
  payloadUrl,
  readGuestPayload,
  ROOT_SCRIPT_MODE,
} from './payloads/assets.js';

export const PAYLOAD_DIRECTORY = '/opt/agent-sprite';

/**
 * deploys a bundled asset through the current guest transaction
 * @param sprite target guest
 * @param filename fixed compiled asset name
 * @param mode intended permissions
 */
export async function deployGuestPayload(
  sprite: Sprite,
  filename: string,
  mode = ROOT_SCRIPT_MODE,
): Promise<void> {
  await writeGuestFile(sprite, {
    path: `${PAYLOAD_DIRECTORY}/${filename}`,
    contents: await readGuestPayload(filename),
    mode,
  });
}
