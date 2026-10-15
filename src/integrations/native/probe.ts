import { GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';
import { runGuestResult } from '#integrations/guest';
import { checkOperation, runBoundedIO } from '#operation';

import { AGENT_PATH, asAgent } from './configuration.js';

import type { GuestChannel } from '#drivers/guest-channel';

const PROBE_TIMEOUT_MS = 180_000;

/**
 * runs one non-model guest probe and parses a bounded JSON response
 * @param guest target guest
 * @param module managed probe module, named by its path under the guest root
 * @returns decoded output when the script is installed and parseable
 */
export async function runNativeProbe(
  guest: GuestChannel,
  module: string,
): Promise<unknown> {
  const path = `${GUEST_ROOT}/${module}`;
  if (!(await runBoundedIO(async () => guest.exists(path)))) {
    return undefined;
  }
  try {
    const result = await runGuestResult(
      guest,
      asAgent(['/usr/bin/env', `PATH=${AGENT_PATH}`, GUEST_NODE, path]),
      { timeoutMs: PROBE_TIMEOUT_MS },
    );

    return JSON.parse(result.stdout) as unknown;
  } catch {
    checkOperation();

    return undefined;
  }
}
