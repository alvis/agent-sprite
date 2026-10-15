import { GUEST_ROOT } from '#guest/guest-root';
import { runGuest, runGuestResult } from '#integrations/guest';
import { withGuestTransaction } from '#integrations/guest/transaction';
import { isRecord } from '#utilities/guards';

import { ensureTailnetDaemon, enrollTailnet } from './daemon.js';
import { inspectTailscale } from './status.js';

import type { NetworkEnrollParams, NetworkExitNode } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { TailnetStatus } from './types.js';

/**
 * starts the persistent Tailscale daemon and enrols through a transient key file
 * @param guest target guest
 * @param enrollment device hostname, enrolment credential and exit-node choice
 */
export async function enrollTailscale(
  guest: GuestChannel,
  enrollment: NetworkEnrollParams,
): Promise<void> {
  const { exitNode, recordIdentity } = enrollment;
  await withGuestTransaction(guest, async () => {
    await ensureTailnetDaemon(guest);
    await selectTailnetExitNode(guest, enrollment);
    const status = await inspectTailscale(guest);
    assertTailnetReady(status, exitNode);
    await recordIdentity({
      deviceId: status.deviceId,
      ip: status.ip,
    });
  });
}

/**
 * enrols a new guest or updates the current native exit-node selection
 * @param guest target guest
 * @param enrollment device hostname, enrolment credential and exit-node choice
 */
async function selectTailnetExitNode(
  guest: GuestChannel,
  enrollment: NetworkEnrollParams,
): Promise<void> {
  const { hostname, credential, exitNode } = enrollment;
  const selected =
    typeof exitNode === 'string' ? exitNode : (exitNode?.ip ?? '');
  const current = await runGuestResult(guest, [
    `${GUEST_ROOT}/tools/tailscale`,
    'status',
    '--json',
  ]);
  const status: unknown =
    current.exitCode === 0 ? JSON.parse(current.stdout) : undefined;
  const enrolled =
    isRecord(status) && isRecord(status.Self) && Boolean(status.Self.ID);
  if (enrolled) {
    await runGuest(guest, [
      `${GUEST_ROOT}/tools/tailscale`,
      'set',
      '--accept-dns=false',
    ]);
    await runGuest(guest, [
      `${GUEST_ROOT}/tools/tailscale`,
      'set',
      `--exit-node=${selected}`,
      '--exit-node-allow-lan-access=false',
      '--accept-dns=true',
    ]);

    return;
  }
  if (!credential) {
    throw new Error(
      'A Tailscale enrolment key is required for this unregistered device',
    );
  }
  await enrollTailnet(guest, { authKey: credential, selected, hostname });
}

/**
 * requires live route, DNS, and egress evidence for the selected exit node
 * @param status current native Tailscale status
 * @param exitNode requested exit node
 */
function assertTailnetReady(
  status: TailnetStatus,
  exitNode?: NetworkExitNode | string,
): void {
  if (!status.online) {
    throw new Error('Tailscale did not confirm current tailnet connectivity');
  }
  if (!exitNode) {
    return;
  }
  if (
    !status.exitNode ||
    status.routeDevice !== 'tailscale0' ||
    !status.dnsReady ||
    !status.egressIp
  ) {
    throw new Error(
      'Tailscale did not confirm current exit route, DNS, and egress readiness',
    );
  }
  const selectedIp =
    typeof exitNode === 'string'
      ? /^[0-9.]+$/.test(exitNode)
        ? exitNode
        : undefined
      : exitNode.ip;
  if (selectedIp && status.exitNodeIp !== selectedIp) {
    throw new Error('Tailscale selected a different exit node than requested');
  }
}
