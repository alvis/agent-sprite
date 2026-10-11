import { checkOperation, recoverOperation, runOperation } from '#operation';

import {
  ensureGuestService,
  guestFileExists,
  removeGuestFile,
  runGuest,
  writeGuestFile,
} from '../guest.js';

import { deployGuestPayload } from './payloads.js';

import type { Sprite } from '@fly/sprites';

const ENROLLMENT_KEY_MODE = 0o600;
const ENROLLMENT_TIMEOUT_MS = 120_000;
const LAUNCHER_PATH = '/opt/agent-sprite/tailscale-launcher.js';
const SCRIPT_MODE = 0o700;

/**
 * prepares writable native DNS and supervises the persistent Tailscale daemon
 * @param sprite target guest with confirmed unrestricted networking
 */
export async function ensureTailnetDaemon(sprite: Sprite): Promise<void> {
  await runGuest(sprite, ['/usr/bin/test', '-c', '/dev/net/tun']);
  const policy = await runOperation(async () => sprite.getNetworkPolicy());
  if (policy.rules.length > 0) {
    throw new Error(
      'Sprite network policy is enforced; refusing to replace its DNS configuration. No network policy was changed.',
    );
  }
  await runGuest(sprite, [
    '/bin/mkdir',
    '-p',
    '/var/lib/tailscale',
    '/var/run/tailscale',
  ]);
  await deployGuestPayload(sprite, 'tailscale-launcher.js', SCRIPT_MODE);
  await runGuest(
    sprite,
    ['/opt/agent-sprite/node/bin/node', LAUNCHER_PATH, '--prepare'],
    {
      step: 'tailscale launcher prepare',
    },
  );
  await ensureGuestService(sprite, 'tailscaled', {
    cmd: '/opt/agent-sprite/node/bin/node',
    args: [LAUNCHER_PATH],
  });
}

/**
 * restores provider DNS and removes only recorded transport exceptions
 * @param sprite guest whose managed daemon has already stopped
 */
export async function restoreTailnetDns(sprite: Sprite): Promise<void> {
  if (await guestFileExists(sprite, LAUNCHER_PATH)) {
    await runGuest(
      sprite,
      ['/opt/agent-sprite/node/bin/node', LAUNCHER_PATH, '--restore'],
      {
        step: 'tailscale launcher restore',
      },
    );
  }
}

/**
 * enrolls a guest and bounds removal of its transient enrollment credential
 * @param sprite target guest
 * @param authKey single-use enrollment credential
 * @param selected requested exit-node selector
 */
export async function enrollTailnet(
  sprite: Sprite,
  authKey: string,
  selected: string,
): Promise<void> {
  const keyPath = '/opt/agent-sprite/tailscale-enrollment.key';
  await writeGuestFile(sprite, {
    path: keyPath,
    contents: `${authKey}\n`,
    mode: ENROLLMENT_KEY_MODE,
    removeOnRelease: true,
  });
  try {
    await runGuest(
      sprite,
      [
        '/opt/agent-sprite/tools/tailscale',
        'up',
        `--auth-key=file:${keyPath}`,
        `--exit-node=${selected}`,
        '--exit-node-allow-lan-access=false',
        '--accept-routes=false',
        `--hostname=${sprite.name}`,
      ],
      { timeoutMs: ENROLLMENT_TIMEOUT_MS },
    );
  } finally {
    await recoverOperation(async () => removeGuestFile(sprite, keyPath)).catch(
      (error: unknown) => {
        checkOperation();
        throw error;
      },
    );
  }
}
