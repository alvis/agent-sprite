import { OPEN_AGENT_VERSION } from '#kernel/version';

import type { GuestMechanics } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';

/**
 * records a finished installation as ready: the record is read back so a
 * device identity enrolment recorded since the plan wrote it is kept
 * @param mechanics the guest's recorded environment
 * @param guest target guest
 */
export async function markInstallationReady(
  mechanics: Pick<GuestMechanics, 'environment'>,
  guest: GuestChannel,
): Promise<void> {
  const environment = await mechanics.environment.read(guest);
  await mechanics.environment.write(guest, {
    ...environment,
    openAgent: {
      version: OPEN_AGENT_VERSION,
      setupAt: new Date().toISOString(),
    },
    setup: { ...environment.setup, state: 'ready' },
  });
}
