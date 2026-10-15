import { SPRITE_AWAKE_MODULE } from './guest-modules.js';

import type { ProviderGuestLeaf } from '#drivers/contracts';

/** the guest facts of Fly Sprites, readable without loading the driver */
export const spriteGuestLeaf: ProviderGuestLeaf = {
  // the Sprite login account receives the same GitHub CLI login as the agent
  shellAccounts: ['sprite'],
  capabilities: {
    guestChannel: 'provider-exec',
    // exit nodes were verified live on a Sprite without any exception
    transportNetworks: [],
    keepAwakeMode: 'native-deadline',
    idleForms: ['provider-managed'],
    wakeMode: 'url-traffic',
    supportsCliWakeSleep: false,
    // the Sprite API keeps a task at most an hour
    maxAwakeDeadlineMinutes: 60,
    persistence: 'provider-disk',
    exposure: 'provider-url',
    discovery: 'provider-metadata',
    // a Sprite has one size, so there is nothing to restart
    resizeRestarts: false,
  },
  // a Sprite runs its services itself
  serviceBackend: 'provider',
  // the agent account applies the deadline, so the adapter never needs root
  awakeAdapter: { module: SPRITE_AWAKE_MODULE, account: 'agent' },
};
