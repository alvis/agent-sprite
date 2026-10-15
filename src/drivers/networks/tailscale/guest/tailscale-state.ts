import { chmod, mkdir } from 'node:fs/promises';

import { GUEST_ROOT } from '../../../../guest/guest-root.js';

/** root-only directory of everything Tailscale keeps across a restart, on the persistent guest root so a provider that discards its root filesystem on a cold boot keeps the node identity */
export const TAILSCALE_STATE_DIRECTORY = `${GUEST_ROOT}/state/tailscale`;

/** the daemon's state file, which holds the enrolled node identity */
export const TAILSCALE_STATE_FILE = `${TAILSCALE_STATE_DIRECTORY}/tailscaled.state`;

/** directory of the daemon's control socket, on the volatile run filesystem */
export const TAILSCALE_SOCKET_DIRECTORY = '/var/run/tailscale';

/** the daemon's control socket */
export const TAILSCALE_SOCKET = `${TAILSCALE_SOCKET_DIRECTORY}/tailscaled.sock`;

/** the state directory's mode: the identity is the daemon's alone */
export const STATE_DIRECTORY_MODE = 0o700;

/** the socket directory's mode */
export const SOCKET_DIRECTORY_MODE = 0o755;

/** the directories the daemon needs before it starts */
export interface TailscaleDirectories {
  /** where the node identity and the managed resolver files live */
  state: string;
  /** where the control socket lives */
  socket: string;
}

/**
 * creates the directories the daemon needs, with their modes, whatever the
 * boot lost; an existing directory keeps its contents and gets the mode
 * @param directories the state and socket directories
 */
export async function ensureTailscaleDirectories(
  directories: TailscaleDirectories = {
    state: TAILSCALE_STATE_DIRECTORY,
    socket: TAILSCALE_SOCKET_DIRECTORY,
  },
): Promise<void> {
  await mkdir(directories.state, {
    recursive: true,
    mode: STATE_DIRECTORY_MODE,
  });
  await mkdir(directories.socket, {
    recursive: true,
    mode: SOCKET_DIRECTORY_MODE,
  });
  // the process umask and an earlier directory must not decide the mode
  await chmod(directories.state, STATE_DIRECTORY_MODE);
  await chmod(directories.socket, SOCKET_DIRECTORY_MODE);
}
