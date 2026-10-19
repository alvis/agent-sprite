import { ensurePrivateDirectory } from '#adapters/guest/platform/account';
import { readTomlObject } from '#adapters/guest/platform/native/configuration';

import { CODEX_CONFIG, CODEX_HOME } from './paths';
import { configureCodexProxy } from './proxy';

import type { HarnessConfigureParams } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';

/**
 * merges the supported Responses provider and native model discovery into Codex TOML
 * @param guest target guest
 * @param params proxy routing to apply, or none to restore native authentication
 */
export async function configureCodex(
  guest: GuestChannel,
  params: HarnessConfigureParams,
): Promise<void> {
  await ensurePrivateDirectory(guest, CODEX_HOME);
  const current = await readTomlObject(guest, CODEX_CONFIG);
  await configureCodexProxy({ guest, current, proxy: params.proxy });
}
