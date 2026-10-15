import { driverModule } from '#guest/guest-root';

import type { GuestPayload } from '#drivers/contracts';

const folder = 'networks/tailscale';

/** compiled module that supervises the Tailscale daemon and its DNS and transport rules */
export const TAILSCALE_LAUNCHER_MODULE = driverModule(
  folder,
  'tailscale-launcher.js',
);

/** compiled module that installs the stable Tailscale release on the guest */
export const TAILSCALE_INSTALL_MODULE = driverModule(
  folder,
  'tailscale-install.js',
);

/** compiled module that names the directories Tailscale keeps its state and socket in, and creates them */
export const TAILSCALE_STATE_MODULE = driverModule(
  folder,
  'tailscale-state.js',
);

/** compiled guest modules Tailscale contributes to the deployable payload */
export const TAILSCALE_GUEST_MODULES: readonly GuestPayload[] = [
  { module: TAILSCALE_LAUNCHER_MODULE, account: 'root' },
  { module: TAILSCALE_INSTALL_MODULE, account: 'root' },
  { module: TAILSCALE_STATE_MODULE, account: 'root' },
];
