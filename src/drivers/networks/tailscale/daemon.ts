import { guestFileExists, runGuest } from '#integrations/guest';

import {
  tailscaleCommand,
  tailscaleDaemon,
  tailscaleLauncher,
} from './service.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type { Secret } from '#integrations/guest/session/secret';

const ENROLLMENT_TIMEOUT_MS = 120_000;

/**
 * supervises the persistent Tailscale daemon, whose launcher setup installed
 * and which prepares writable native DNS each time it starts
 * @param guest target guest with confirmed unrestricted networking
 */
export async function ensureTailnetDaemon(guest: GuestChannel): Promise<void> {
  await runGuest(guest, ['/usr/bin/test', '-c', '/dev/net/tun']);
  await guest.assertUnrestrictedNetwork();
  await guest.services.ensure(tailscaleDaemon);
}

/**
 * restores provider DNS and removes only recorded transport exceptions
 * @param guest guest whose managed daemon has already stopped
 */
export async function restoreTailnetDns(guest: GuestChannel): Promise<void> {
  const { asset, stateDirectory } = tailscaleLauncher;
  if (await guestFileExists(guest, asset.installAs)) {
    await runGuest(
      guest,
      ['/bin/sh', asset.installAs, '--restore', stateDirectory],
      { step: 'tailscale launcher restore' },
    );
  }
}

/** credential, exit-node selector and device name for one enrollment */
export interface TailnetEnrollParams {
  /** single-use enrollment credential */
  authKey: Secret;
  /** requested exit-node selector */
  selected: string;
  /** tailnet device hostname */
  hostname: string;
}

/**
 * the program that enrols with the key file the session wrote for it: it
 * opens the file, removes it and hands the CLI only the open descriptor, so
 * the key is never at rest once the CLI starts; its arguments are the CLI's
 */
const ENROLL_PROGRAM =
  '{ rm -f "$OPEN_AGENT_SECRET_FILE" && exec "$@" --auth-key=file:/dev/fd/3; } 3<"$OPEN_AGENT_SECRET_FILE"';

/**
 * enrolls a guest with its single-use credential, delivered as a private
 * session file removed before the CLI starts
 * @param guest target guest, running over a setup session
 * @param params enrollment credential, exit-node selector and device name
 */
export async function enrollTailnet(
  guest: GuestChannel,
  params: TailnetEnrollParams,
): Promise<void> {
  const { authKey, selected, hostname } = params;
  await runGuest(
    guest,
    [
      '/bin/sh',
      '-c',
      ENROLL_PROGRAM,
      'oa-tailscale-up',
      ...tailscaleCommand(
        'up',
        `--exit-node=${selected}`,
        '--exit-node-allow-lan-access=false',
        '--accept-routes=false',
        `--hostname=${hostname}`,
      ),
    ],
    {
      secret: { value: authKey, as: 'shm-file' },
      timeoutMs: ENROLLMENT_TIMEOUT_MS,
      step: 'tailscale up',
    },
  );
}
