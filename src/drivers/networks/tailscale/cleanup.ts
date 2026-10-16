import { CommandFault, ensureError } from '#errors';
import { cancellationReason, currentOperation } from '#operation';

import {
  deleteTailnetDevice,
  findTailnetDevice,
  resolveExitNode,
} from './api.js';
import { ensureTailnetDaemon } from './daemon.js';
import { inspectTailscale } from './status.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type {
  NetworkCleanup,
  NetworkCleanupParams,
  NetworkStaleDeviceParams,
  NetworkTargetParams,
} from '#drivers/networks/contracts';

import type { TailnetStatus } from './types.js';

/**
 * protects the selected home exit node from cleanup even under a bad identity
 * @param params captured guest identity, management credential and selected home exit node
 */
export async function assertSafeTailnetTarget(
  params: NetworkTargetParams<TailnetStatus>,
): Promise<void> {
  const { identity, management, exitNode } = params;
  const {
    deviceId: guestNodeId,
    ip: tailnetIp,
    exitNode: exitNodeId,
  } = identity;
  if (guestNodeId && guestNodeId === exitNodeId) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: 'Refusing to delete a Sprite configured as its own exit node',
    });
  }
  if (!guestNodeId || !management?.account || !exitNode) {
    return;
  }
  const homeNode = await resolveExitNode(
    management.credential,
    management.account,
    exitNode,
  );
  if (homeNode.id === guestNodeId || homeNode.ip === tailnetIp) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: 'Refusing to delete the selected home exit node',
    });
  }
}

/**
 * deletes the captured guest node after Sprite deletion, or reports work remaining
 * @param params captured identity and local management credential
 * @returns whether the device was removed, and why not otherwise
 */
export async function cleanupTailnetDevice(
  params: NetworkCleanupParams,
): Promise<NetworkCleanup> {
  const { identity, management } = params;
  const { deviceId, ip } = identity;
  if (currentOperation()?.signal.aborted) {
    return {
      ok: false,
      status: 'cleanup required',
      cause: cancellationReason(),
    };
  }
  if (!deviceId && !ip) {
    return { ok: true, status: 'no device identity recorded' };
  }
  if (!management || !deviceId) {
    return { ok: false, status: 'cleanup required' };
  }
  try {
    await deleteTailnetDevice(management.credential, deviceId);

    return { ok: true, status: 'deleted' };
  } catch (error) {
    return { ok: false, status: 'cleanup failed', cause: ensureError(error) };
  }
}

/**
 * removes the device a logged-out guest used to hold, so enrolment keeps the
 * workstation name; the daemon is started first and a guest that still holds
 * any device is left alone, because only a logged-out guest has lost the device
 * environment.json recorded
 * @param guest target guest
 * @param params identity environment.json recorded and the management credential
 * @throws {CommandFault} when the recorded device exists and cannot be deleted
 */
export async function removeStaleTailnetDevice(
  guest: GuestChannel,
  params: NetworkStaleDeviceParams,
): Promise<void> {
  const { recorded, management } = params;
  const { deviceId } = recorded;
  if (!deviceId || !management?.account) {
    return;
  }
  await ensureTailnetDaemon(guest);
  if ((await inspectTailscale(guest)).deviceId) {
    return;
  }
  const device = await findTailnetDevice(
    management.credential,
    management.account,
    deviceId,
  );
  if (!device) {
    return;
  }
  try {
    await deleteTailnetDevice(management.credential, deviceId);
  } catch (error) {
    throw new CommandFault({
      code: error instanceof CommandFault ? error.code : 'PROVIDER',
      message: `Tailnet device ${device.name} (${deviceId}) is this workstation's earlier registration and holds its name; the management API key could not delete it, so enrolling now would register a suffixed name. Delete it in Tailscale Machines or use a key allowed to delete devices, then rerun setup`,
      cause: error,
    });
  }
}
