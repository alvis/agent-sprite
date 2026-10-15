import { CLIPROXYAPI_GUEST_MODULES } from './guest-modules.js';

import type { SharedGuestLeaf } from '#drivers/contracts';

/** the guest facts of the CLIProxyAPI hub client, readable without loading any driver */
export const cliproxyapiGuestLeaf: SharedGuestLeaf = {
  guest: CLIPROXYAPI_GUEST_MODULES,
};
