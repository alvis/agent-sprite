import { guestAsset } from '#guest/assets';
import { GUEST_ROOT } from '#guest/guest-root';
import { ROOT_ONLY_MODE } from '#os/contracts';

import type { ServiceDefinition } from '#drivers/guest-channel';
import type { NetworkLauncher } from '#drivers/networks/contracts';

/** root-only directory of everything Tailscale keeps across a restart, on the persistent guest root so a provider that discards its root filesystem on a cold boot keeps the node identity */
const TAILSCALE_STATE_DIRECTORY = `${GUEST_ROOT}/state/tailscale`;

/** the daemon's state file, which holds the enrolled node identity */
export const TAILSCALE_STATE_FILE = `${TAILSCALE_STATE_DIRECTORY}/tailscaled.state`;

/** the daemon's control socket, on the volatile run filesystem */
const TAILSCALE_SOCKET = '/var/run/tailscale/tailscaled.sock';

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

/**
 * renders a Tailscale CLI command bound to the managed daemon's socket; the
 * CLI is the installed tool on the PATH
 * @param args the subcommand and its arguments
 * @returns argv that runs the CLI against the managed socket
 */
export function tailscaleCommand(...args: string[]): string[] {
  return ['tailscale', `--socket=${TAILSCALE_SOCKET}`, ...args];
}
