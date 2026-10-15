import { TAILSCALE_INSTALL_MODULE } from './guest-modules.js';

import type { ReleaseInstallSource } from '#drivers/contracts';

/** the official stable release feed and the guest module the current guest installer installs Tailscale with */
export const tailscaleRelease: ReleaseInstallSource = {
  kind: 'release',
  feed: 'https://pkgs.tailscale.com/stable/?mode=json',
  installer: TAILSCALE_INSTALL_MODULE,
};
