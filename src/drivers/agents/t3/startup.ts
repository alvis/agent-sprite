import { runAsAgent } from '#integrations/guest/account';

import { t3Tool } from './tools.js';

import type { GuestChannel } from '#drivers/guest-channel';

/**
 * checks required private T3 startup options before supervising it
 * @param guest target guest
 */
export async function verifyT3Startup(guest: GuestChannel): Promise<void> {
  const help = await runAsAgent(guest, [
    t3Tool.version.executable,
    'start',
    '--help',
  ]);
  if (
    !help.stdout.includes('--log-level') ||
    !help.stdout.includes('--no-browser')
  ) {
    throw new Error('Installed T3 lacks the required private startup flags');
  }
}
