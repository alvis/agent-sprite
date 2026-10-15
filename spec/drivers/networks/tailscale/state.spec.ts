import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TAILSCALE_SOCKET,
  TAILSCALE_STATE_DIRECTORY,
  TAILSCALE_STATE_FILE,
  ensureTailscaleDirectories,
} from '#drivers/networks/tailscale/guest/tailscale-state';
import { GUEST_ROOT } from '#guest/guest-root';

/**
 * reads the permission bits of a path
 * @param path file or directory
 * @returns the mode without the file type
 */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('Tailscale state paths', () => {
  it('should keep the node identity under the persistent guest root, away from the root filesystem a cold boot discards', () => {
    expect({
      directory: TAILSCALE_STATE_DIRECTORY,
      file: TAILSCALE_STATE_FILE,
      socket: TAILSCALE_SOCKET,
    }).toEqual({
      directory: `${GUEST_ROOT}/state/tailscale`,
      file: `${GUEST_ROOT}/state/tailscale/tailscaled.state`,
      socket: '/var/run/tailscale/tailscaled.sock',
    });
  });
});

describe('fn:ensureTailscaleDirectories', () => {
  it('should create both directories, nested, with a root-only state directory, on a boot that lost them', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-state-'),
    );
    const state = join(directory.path, 'state', 'tailscale');
    const socket = join(directory.path, 'run', 'tailscale');
    const mask = process.umask(0o077);

    try {
      await ensureTailscaleDirectories({ state, socket });
    } finally {
      process.umask(mask);
    }

    expect({
      state: await modeOf(state),
      parent: await modeOf(join(directory.path, 'state')),
      socket: await modeOf(socket),
    }).toEqual({ state: 0o700, parent: 0o700, socket: 0o755 });
  });

  it('should keep what an existing state directory holds and correct its mode', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-state-'),
    );
    const state = join(directory.path, 'state');
    const socket = join(directory.path, 'run');
    await mkdir(state);
    await mkdir(socket);
    await chmod(state, 0o755);
    await chmod(socket, 0o700);
    await writeFile(join(state, 'tailscaled.state'), 'enrolled');

    await ensureTailscaleDirectories({ state, socket });

    expect({
      identity: await readFile(join(state, 'tailscaled.state'), 'utf8'),
      state: await modeOf(state),
      socket: await modeOf(socket),
    }).toEqual({ identity: 'enrolled', state: 0o700, socket: 0o755 });
  });
});
