import { GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';

import { TAILSCALE_LAUNCHER_MODULE } from './guest-modules.js';

import type { ServiceDefinition } from '#drivers/guest-channel';

/** path of the launcher that prepares native DNS and supervises the daemon */
export const LAUNCHER_PATH = `${GUEST_ROOT}/${TAILSCALE_LAUNCHER_MODULE}`;

/** the persistent Tailscale daemon, supervised as root and depending on nothing */
export const tailscaleDaemon: ServiceDefinition = {
  name: 'tailscaled',
  command: GUEST_NODE,
  arguments: [LAUNCHER_PATH],
  account: 'root',
  needs: [],
};
