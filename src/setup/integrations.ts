import { assertGuestIntegrations } from '#integrations/guest/manifest';
import {
  disableTailscale,
  writeGuestIntegrations,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';

import type { Sprite } from '@fly/sprites';

import type { SetupContext } from './context.js';

/**
 * persists validated selections and disables an explicitly deselected daemon
 * @param sprite selected managed guest
 * @param integrations validated integration choices
 * @param context prior choices and mutation tracking
 * @param context.mutation tracks whether setup changed guest state
 * @param context.expected selections observed before collecting user input
 */
export async function persistSetupIntegrations(
  sprite: Sprite,
  integrations: SetupContext['integrations'],
  context: Pick<SetupContext, 'mutation'> & {
    expected: SetupContext['integrations'];
  },
): Promise<void> {
  const { mutation, expected } = context;
  await withGuestTransaction(sprite, async () => {
    await assertGuestIntegrations(sprite, expected);
    mutation.started = true;
    if (!integrations.tailscale) {
      await disableTailscale(sprite);
    }
    await writeGuestIntegrations(sprite, integrations);
  });
}
