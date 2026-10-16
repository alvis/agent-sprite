import { restoreTailnetDns } from './daemon.js';
import { tailscaleDaemon } from './service.js';
import { inspectTailscale } from './status.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type { NetworkReleaseParams } from '#drivers/networks/contracts';

/**
 * stops the managed Tailscale daemon while retaining enrolment and cleanup identity
 * @param guest target guest, inside the caller's guest transaction
 * @param params the daemon as currently registered
 */
export async function releaseTailscale(
  guest: GuestChannel,
  params: NetworkReleaseParams,
): Promise<void> {
  const { service, recordIdentity } = params;
  if (service?.status === 'running') {
    const status = await inspectTailscale(guest);
    await recordIdentity({
      deviceId: status.deviceId,
      ip: status.ip,
    });
    if (!(await guest.services.stop(tailscaleDaemon.name))) {
      throw new Error('Tailscale service reported a stop failure');
    }
  }
  if (service) {
    await guest.services.remove(tailscaleDaemon.name);
  }
  await restoreTailnetDns(guest);
}
