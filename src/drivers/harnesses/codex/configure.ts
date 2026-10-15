import { withGuestTransaction } from '#integrations/guest/transaction';
import {
  ensurePrivateDirectory,
  readTomlObject,
} from '#integrations/native/configuration';

import { CODEX_CONFIG, CODEX_HOME } from './paths.js';
import { configureCodexProxy } from './proxy.js';

import type { HarnessConfigureParams } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

/**
 * merges the supported Responses provider and native model discovery into Codex TOML
 * @param guest target guest
 * @param params proxy routing to apply, or none to restore native authentication
 */
export async function configureCodex(
  guest: GuestChannel,
  params: HarnessConfigureParams,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    await ensurePrivateDirectory(guest, CODEX_HOME);
    const current = await readTomlObject(guest, CODEX_CONFIG);
    await configureCodexProxy({ guest, current, proxy: params.proxy });
  });
}
