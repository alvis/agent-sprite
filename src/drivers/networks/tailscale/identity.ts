import { CommandFault, commandError } from '#errors';
import { checkOperation, runBoundedIO } from '#operation';

import { TAILSCALE_STATE_FILE } from './service.js';
import { inspectTailscale } from './status.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type { NetworkRecord } from '#drivers/networks/contracts';

import type { TailnetStatus } from './types.js';

/**
 * captures enrolled identity without requiring a completed installation
 * @param guest ownership-checked target before permanent deletion
 * @param record what environment.json recorded about the network
 * @returns captured native or persisted managed tailnet identity
 */
export async function identifyTailnetDevice(
  guest: GuestChannel,
  record: NetworkRecord,
): Promise<TailnetStatus> {
  const offline: TailnetStatus = {
    ...record.identity,
    online: false,
    dnsReady: false,
    skipped: true,
  };
  if (!(await runBoundedIO(async () => guest.exists(TAILSCALE_STATE_FILE)))) {
    return offline;
  }
  let inspected: TailnetStatus | undefined;
  let inspectionFailure: { cause: unknown } | undefined;
  try {
    inspected = await inspectTailscale(guest);
  } catch (error) {
    checkOperation();
    if (commandError(error).code === 'CANCELLED') {
      throw error;
    }
    inspectionFailure = { cause: error };
  }
  if (inspected?.deviceId) {
    return inspected;
  }
  if (offline.deviceId) {
    return inspected
      ? {
          ...inspected,
          deviceId: offline.deviceId,
          ip: inspected.ip ?? offline.ip,
        }
      : offline;
  }
  throw new CommandFault({
    code: inspectionFailure ? 'PROVIDER' : 'PREFLIGHT',
    message:
      'Tailnet enrollment state exists but its device identity could not be captured; recover setup before termination. No resources were deleted.',
    cause: inspectionFailure?.cause,
    causeVisibility: 'private',
  });
}
