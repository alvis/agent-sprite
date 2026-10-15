import { TAILSCALE_INSTALL_MODULE } from './guest-modules.js';

import type { InstallSpec } from '#drivers/contracts';

/** the official stable Tailscale release, installed under the guest root while a workstation selects Tailscale */
export const tailscaleInstall: InstallSpec = {
  component: 'tailscale',
  source: {
    kind: 'release',
    feed: 'https://pkgs.tailscale.com/stable/?mode=json',
    installer: TAILSCALE_INSTALL_MODULE,
  },
  versionProbe: {
    program: '/usr/local/bin/tailscale',
    arguments: ['version'],
    account: 'agent',
  },
};
