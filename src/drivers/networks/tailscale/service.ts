import { guestAsset } from '#guest/assets';
import { ROOT_ONLY_MODE } from '#os/contracts';

import {
  TAILSCALE_SOCKET,
  TAILSCALE_STATE_DIRECTORY,
} from './guest/tailscale-state.js';

import type { ServiceDefinition } from '#drivers/guest-channel';
import type { NetworkLauncher } from '#drivers/networks/contracts';

/**
 * the launcher that routes the provider's resolvers and transport outside the
 * tunnel, hands tailscaled a resolver it may rewrite, then runs tailscaled
 */
export const tailscaleLauncher: NetworkLauncher = {
  asset: guestAsset(
    'drivers/networks/tailscale/guest/tailscale-launcher.sh',
    ROOT_ONLY_MODE,
  ),
  stateDirectory: TAILSCALE_STATE_DIRECTORY,
  socket: TAILSCALE_SOCKET,
  tun: 'tailscale0',
};

/** the persistent Tailscale daemon, supervised as root and depending on nothing */
export const tailscaleDaemon: ServiceDefinition = {
  name: 'tailscaled',
  command: '/bin/sh',
  arguments: [tailscaleLauncher.asset.installAs],
  account: 'root',
  needs: [],
};
