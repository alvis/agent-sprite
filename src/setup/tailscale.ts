import { assertGuestIntegrations } from '#integrations/guest/manifest';
import {
  configureTailscale,
  installManagedServices,
  inspectTailscale,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';
import {
  createTailscaleAuthKey,
  resolveExitNode,
  matchesExitNode,
} from '#integrations/tailscale';

import type { Sprite } from '@fly/sprites';

import type { TailscaleSetupData } from '#command/data';

import type { ResolvedInputs } from '#input/types';
import type { TailnetExitNode } from '#integrations/tailscale';

import type { SetupContext } from './context.js';

/**
 * configures or update the existing tailnet device's selected exit route
 * @param sprite exact managed Sprite
 * @param context tailnet choices, prompts, and redaction values
 * @returns selected Tailscale route summary
 */
export async function setupTailscale(
  sprite: Sprite,
  context: SetupContext,
): Promise<TailscaleSetupData> {
  const { input, integrations, tailscaleEnrolled, mutation } = context;
  if (!integrations.tailscale) {
    return {
      tailscale: { status: 'disabled', readiness: 'skipped' },
    };
  }
  if (!input.tailnet || (integrations.exitNode && !input.exitNode)) {
    throw new Error('Validated Tailscale inputs were unavailable');
  }
  const verified = context.verifiedExitNode;
  const authKey = await resolveEnrollmentKey(input, tailscaleEnrolled);

  return withGuestTransaction(sprite, async () => {
    await assertGuestIntegrations(sprite, integrations);
    mutation.started = true;
    const selectedExitNode = integrations.exitNode
      ? (verified?.ip ?? input.exitNode)
      : undefined;
    await configureTailscale(sprite, authKey, selectedExitNode);
    await installManagedServices(sprite);
    const observed = await inspectTailscale(sprite);
    if (selectedExitNode && !matchesExitNode(selectedExitNode, observed)) {
      throw new Error(
        'The selected exit node does not match current Tailscale status',
      );
    }

    return {
      tailscale: {
        status: 'configured',
        exitNode: integrations.exitNode
          ? (verified?.name ?? input.exitNode)
          : undefined,
      },
    };
  });
}

/**
 * reuses an enrolled device or mint one short-lived key for a new device
 * @param input resolved Tailscale credentials and tailnet
 * @param enrolled whether the guest already has a device identity
 * @returns a transient key for a new device, or undefined for an enrolled one
 */
async function resolveEnrollmentKey(
  input: ResolvedInputs,
  enrolled: boolean,
): Promise<string | undefined> {
  if (enrolled) {
    return undefined;
  }
  const key =
    input.tailscaleAuthKey ??
    (input.tailscaleApiKey && input.tailnet
      ? await createTailscaleAuthKey(input.tailscaleApiKey, input.tailnet)
      : undefined);
  if (!key) {
    throw new Error('Tailscale enrolment credential unavailable');
  }

  return key;
}

/**
 * verifies selected exit routing before any setup mutation
 * @param input resolved local Tailscale credentials and selectors
 * @param integrations integrations affected by this setup section
 * @returns approved exit identity when caller-side management access is available
 */
export async function verifySetupExitNode(
  input: ResolvedInputs,
  integrations: SetupContext['integrations'],
): Promise<TailnetExitNode | undefined> {
  return integrations.exitNode &&
    input.tailscaleApiKey &&
    input.tailnet &&
    input.exitNode
    ? resolveExitNode(input.tailscaleApiKey, input.tailnet, input.exitNode)
    : undefined;
}
