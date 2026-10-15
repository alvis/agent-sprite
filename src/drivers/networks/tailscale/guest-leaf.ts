import { TAILSCALE_GUEST_MODULES } from './guest-modules.js';
import { tailscaleRelease } from './install.js';
import { tailscaleTool } from './tools.js';

import type { NetworkGuestLeaf } from '#drivers/contracts';

/** the guest facts of Tailscale, readable without loading the driver */
export const tailscaleGuestLeaf: NetworkGuestLeaf = {
  guest: TAILSCALE_GUEST_MODULES,
  tools: [tailscaleTool],
  releaseFeed: tailscaleRelease,
};
