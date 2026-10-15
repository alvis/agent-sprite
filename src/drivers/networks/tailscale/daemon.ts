import { GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';
import {
  guestFileExists,
  removeGuestFile,
  runGuest,
  writeGuestFile,
} from '#integrations/guest';
import { deployGuestPayload } from '#integrations/guest/payloads';
import { checkOperation, recoverOperation } from '#operation';

import {
  TAILSCALE_LAUNCHER_MODULE,
  TAILSCALE_STATE_MODULE,
} from './guest-modules.js';
import { LAUNCHER_PATH, tailscaleDaemon } from './service.js';

import type { GuestChannel } from '#drivers/guest-channel';

const ENROLLMENT_KEY_MODE = 0o600;
const ENROLLMENT_TIMEOUT_MS = 120_000;

/**
 * prepares writable native DNS and supervises the persistent Tailscale daemon
 * @param guest target guest with confirmed unrestricted networking
 */
export async function ensureTailnetDaemon(guest: GuestChannel): Promise<void> {
  await runGuest(guest, ['/usr/bin/test', '-c', '/dev/net/tun']);
  await guest.assertUnrestrictedNetwork();
  // the launcher imports the state module, so both are deployed together
  await deployGuestPayload(guest, TAILSCALE_STATE_MODULE);
  await deployGuestPayload(guest, TAILSCALE_LAUNCHER_MODULE);
  await runGuest(guest, [GUEST_NODE, LAUNCHER_PATH, '--prepare'], {
    step: 'tailscale launcher prepare',
  });
  await guest.services.ensure(tailscaleDaemon);
}

/**
 * restores provider DNS and removes only recorded transport exceptions
 * @param guest guest whose managed daemon has already stopped
 */
export async function restoreTailnetDns(guest: GuestChannel): Promise<void> {
  if (await guestFileExists(guest, LAUNCHER_PATH)) {
    await runGuest(guest, [GUEST_NODE, LAUNCHER_PATH, '--restore'], {
      step: 'tailscale launcher restore',
    });
  }
}

/** credential, exit-node selector and device name for one enrollment */
export interface TailnetEnrollParams {
  /** single-use enrollment credential */
  authKey: string;
  /** requested exit-node selector */
  selected: string;
  /** tailnet device hostname */
  hostname: string;
}

/**
 * enrolls a guest and bounds removal of its transient enrollment credential
 * @param guest target guest
 * @param params enrollment credential, exit-node selector and device name
 */
export async function enrollTailnet(
  guest: GuestChannel,
  params: TailnetEnrollParams,
): Promise<void> {
  const { authKey, selected, hostname } = params;
  const keyPath = `${GUEST_ROOT}/tailscale-enrollment.key`;
  await writeGuestFile(guest, {
    path: keyPath,
    contents: `${authKey}\n`,
    mode: ENROLLMENT_KEY_MODE,
    removeOnRelease: true,
  });
  try {
    await runGuest(
      guest,
      [
        `${GUEST_ROOT}/tools/tailscale`,
        'up',
        `--auth-key=file:${keyPath}`,
        `--exit-node=${selected}`,
        '--exit-node-allow-lan-access=false',
        '--accept-routes=false',
        `--hostname=${hostname}`,
      ],
      { timeoutMs: ENROLLMENT_TIMEOUT_MS },
    );
  } finally {
    await recoverOperation(async () => removeGuestFile(guest, keyPath)).catch(
      (error: unknown) => {
        checkOperation();
        throw error;
      },
    );
  }
}
