import { CommandFault } from '#errors';
import { runOperation } from '#operation';

import {
  assertTailnetHostnameAvailable,
  createTailscaleAuthKey,
  resolveExitNode,
} from './api.js';

import type {
  NetworkExitNode,
  NetworkManagement,
  NetworkPreflightParams,
  NetworkPreflightResult,
} from '#drivers/networks/contracts';

/**
 * checks the selected exit node and the exact device name before provisioning
 * @param params device name, management credential and exit node selector
 * @returns the verified exit node and every failed check in the order made
 */
export async function preflightTailscale(
  params: NetworkPreflightParams,
): Promise<NetworkPreflightResult> {
  const { hostname, management, exitNode } = params;
  const credential = management?.account ? management.credential : undefined;
  const account = management?.account;
  const [exit, availability] = await runOperation(async () =>
    Promise.allSettled([
      exitNode && credential && account
        ? resolveExitNode(credential, account, exitNode)
        : Promise.resolve(undefined),
      credential && account
        ? assertTailnetHostnameAvailable(credential, account, hostname)
        : Promise.resolve(),
    ]),
  );

  return {
    exitNode: exit.status === 'fulfilled' ? exit.value : undefined,
    problems: [exit, availability].flatMap((check) =>
      check.status === 'rejected' ? [check.reason as unknown] : [],
    ),
  };
}

/**
 * verifies one exit node selector against the tailnet inventory
 * @param management Tailscale management API key and tailnet
 * @param selector exit node name, identity or address
 * @returns the unique approved exit node
 */
export async function verifyTailscaleExitNode(
  management: NetworkManagement,
  selector: string,
): Promise<NetworkExitNode> {
  if (!management.account) {
    throw new CommandFault({
      code: 'INPUT',
      message:
        'Exit node verification requires the tailnet of the management API key',
    });
  }

  return resolveExitNode(management.credential, management.account, selector);
}

/**
 * mints a short-lived single-use enrolment key from the management credential
 * @param management Tailscale management API key and tailnet
 * @returns transient key for one new device
 */
export async function issueTailscaleCredential(
  management: NetworkManagement,
): Promise<string> {
  if (!management.account) {
    throw new CommandFault({
      code: 'INPUT',
      message:
        'Tailscale enrolment requires the tailnet of the management API key',
    });
  }

  return createTailscaleAuthKey(management.credential, management.account);
}
