import { GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';
import { removeGuestFile, runGuest, writeGuestFile } from '#integrations/guest';
import { runBoundedIO } from '#operation';
import { isRecord } from '#utilities/guards';

import { resolveProxyEndpoints } from './endpoints.js';
import { HUB_PROBE_MODULE, HUB_RECORD_FILE } from './guest-modules.js';

import type { ProxyRoute } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

/** non-billable current gateway reachability result */
export interface HubStatus {
  /** whether the gateway answered its model catalogue request */
  reachable: boolean;
  /** whether the check was skipped because the gateway is not selected */
  skipped: boolean;
  /** HTTP status the gateway answered with */
  status?: number;
  /** bounded reason the gateway could not be reached */
  reason?: string;
}

const HUB_PROBE = `${GUEST_ROOT}/${HUB_PROBE_MODULE}`;
const HUB_RECORD = `${GUEST_ROOT}/${HUB_RECORD_FILE}`;
// the record holds the client key, so only root, which runs the probe, reads it
const HUB_RECORD_MODE = 0o600;

/**
 * records the gateway the probe checks, or forgets it when routing is off
 * @param guest target guest
 * @param route CLIProxyAPI route, or undefined when no gateway is configured
 */
export async function recordHub(
  guest: GuestChannel,
  route: ProxyRoute | undefined,
): Promise<void> {
  if (!route) {
    await removeGuestFile(guest, HUB_RECORD);

    return;
  }
  await writeGuestFile(guest, {
    path: HUB_RECORD,
    contents: `${JSON.stringify({
      models: resolveProxyEndpoints(route.url).models,
      apiKey: route.apiKey,
    })}\n`,
    mode: HUB_RECORD_MODE,
  });
}

/**
 * checks the recorded gateway's model catalogue without generating a model turn
 * @param guest target guest
 * @returns gateway model-catalogue reachability
 */
export async function inspectHub(guest: GuestChannel): Promise<HubStatus> {
  if (!(await runBoundedIO(async () => guest.exists(HUB_PROBE)))) {
    return {
      reachable: false,
      skipped: false,
      reason: 'gateway probe is not installed',
    };
  }
  const result = await runGuest(guest, [GUEST_NODE, HUB_PROBE, HUB_RECORD]);
  const status = parseProbeResult(result.stdout);

  return {
    reachable: status.reachable,
    skipped: false,
    status: typeof status.status === 'number' ? status.status : undefined,
    reason: typeof status.reason === 'string' ? status.reason : undefined,
  };
}

/**
 * validates the probe's single JSON result
 * @param stdout probe output
 * @returns the decoded result
 * @throws {Error} when the probe printed no well-formed result
 */
function parseProbeResult(
  stdout: string,
): Record<string, unknown> & { reachable: boolean } {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    status = undefined;
  }
  if (!isRecord(status) || typeof status.reachable !== 'boolean') {
    throw new Error('Gateway readiness probe returned a malformed result');
  }

  return { ...status, reachable: status.reachable };
}
