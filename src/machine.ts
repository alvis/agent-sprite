import {
  getSpriteUrl,
  SETUP_INCOMPLETE_LABEL,
  SETUP_READY_LABEL,
} from '#integrations/sprites';

import { CommandFault } from './errors.js';

import type { Sprite } from '@fly/sprites';

import type { PairingSecret } from '#utilities/pairing-secret';

const DNS_LABEL_MAX_LENGTH = 63;

/** control-plane details only; guest state is never inferred from this projection */
export interface MachineSummary {
  id: string;
  name: string;
  organization: string;
  createdAt?: string;
  state: string;
  t3Url?: string | PairingSecret;
  setup: 'ready' | 'incomplete' | 'not recorded';
  readiness: 'not inspected';
}

/**
 * validates a user-selected hostname before provisioning
 * @param name requested DNS-compatible machine name
 */
export function validateMachineName(name: string): void {
  if (
    name.length > DNS_LABEL_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  ) {
    throw new CommandFault({
      code: 'INPUT',
      message:
        'Workstation name must be a lowercase DNS label of at most 63 characters',
    });
  }
}

/**
 * converts a live SDK Sprite into control-plane data with optional pairing consent
 * @param sprite freshly fetched provider Sprite
 * @param pairingCode explicitly disclosed native T3 code to attach to its normal URL
 * @returns a control-plane summary with guest readiness marked uninspected
 */
export function summarizeMachine(
  sprite: Sprite,
  pairingCode?: PairingSecret,
): MachineSummary {
  if (!sprite.id || !sprite.organizationName) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Sprite ${sprite.name} lacks immutable provider identity`,
    });
  }

  return {
    id: sprite.id,
    name: sprite.name,
    organization: sprite.organizationName,
    createdAt: sprite.createdAt?.toISOString(),
    state: sprite.status ?? 'unknown',
    t3Url: sprite.url
      ? pairingCode
        ? pairingCode.forUrl(getSpriteUrl(sprite))
        : getSpriteUrl(sprite)
      : undefined,
    setup: sprite.labels.includes(SETUP_READY_LABEL)
      ? 'ready'
      : sprite.labels.includes(SETUP_INCOMPLETE_LABEL)
        ? 'incomplete'
        : 'not recorded',
    readiness: 'not inspected',
  };
}
