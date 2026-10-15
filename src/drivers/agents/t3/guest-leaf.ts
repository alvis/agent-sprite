import { T3_HARNESS_NAMES } from './harness-names.js';
import { T3_GUEST_PACKAGES, T3_RELEASE_CHANNELS } from './install.js';
import { t3Service } from './service.js';
import { T3_TOOLS } from './tools.js';

import type { AgentGuestLeaf } from '#drivers/contracts';

import type { T3HarnessId } from './harness-names.js';

/** the guest facts of T3 Code, readable without loading the driver */
export const t3GuestLeaf: AgentGuestLeaf<T3HarnessId> = {
  guest: [],
  tools: T3_TOOLS,
  guestPackages: T3_GUEST_PACKAGES,
  releaseChannels: T3_RELEASE_CHANNELS,
  service: t3Service,
  harnessNames: T3_HARNESS_NAMES,
};
