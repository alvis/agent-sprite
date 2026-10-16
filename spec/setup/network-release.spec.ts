import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceLogStream } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { tailscaleLauncher } from '#drivers/networks/tailscale/service';
import { ENVIRONMENT_PATH } from '#integrations/guest/layout';
import { persistSetupProfile } from '#setup/integrations';

import { environmentOf } from '../fixtures/environment.js';
import {
  DISABLED_NETWORK_PROFILE,
  TAILSCALE_PROFILE,
} from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  serveServiceRegistry,
} from '../mocks/sprites.js';

import type { ServiceWithState, Sprite } from '@fly/sprites';

import type { WorkstationProfile } from '#core/profile';

const LAUNCHER_PATH = tailscaleLauncher.asset.installAs;

const tailscaled = {
  name: 'tailscaled',
  cmd: '/usr/bin/sudo',
  args: [],
  needs: [],
  state: { name: 'tailscaled', status: 'stopped' },
} satisfies ServiceWithState;

/**
 * stands up a set-up workstation whose guest holds the Tailscale launcher
 * @param root directory standing for the guest filesystem
 * @param recorded selection the environment records
 * @param services services the provider reports as registered
 * @returns the sprite, with service mutations answered by the mock
 */
async function workstation(
  root: string,
  recorded: WorkstationProfile,
  services: ServiceWithState[],
): Promise<Sprite> {
  const sprite = createFilesystemSprite({
    root,
    execute: async (_file, args = []) => ({
      stdout: args.includes('/usr/bin/id') ? '1000' : '',
      stderr: '',
      exitCode: 0,
    }),
  });
  const filesystem = sprite.filesystem();
  await filesystem.writeFile(LAUNCHER_PATH, '# staged launcher\n');
  await filesystem.writeFile(
    ENVIRONMENT_PATH,
    JSON.stringify(environmentOf(recorded)),
  );
  vi.spyOn(sprite, 'listServices').mockResolvedValue(services);
  serveServiceRegistry(sprite);
  vi.spyOn(sprite, 'stopService').mockImplementation(
    async () =>
      new ServiceLogStream(new Response('{"type":"complete","timestamp":0}\n')),
  );
  vi.spyOn(sprite, 'deleteService').mockResolvedValue(undefined);
  vi.spyOn(sprite, 'createService').mockImplementation(
    async () =>
      new ServiceLogStream(new Response('{"type":"complete","timestamp":0}\n')),
  );

  return sprite;
}

/**
 * counts the launcher restore runs a sprite received
 * @param sprite workstation under test
 * @returns how many times the guest ran the Tailscale launcher
 */
function launcherRuns(sprite: Sprite): number {
  return vi
    .mocked(sprite.execFile)
    .mock.calls.filter(([, args]) => args?.includes(LAUNCHER_PATH)).length;
}

describe('fn:persistSetupProfile network section', () => {
  it('should release nothing for a workstation that never recorded or registered a network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-network-none-'),
    );
    const sprite = await workstation(
      directory.path,
      DISABLED_NETWORK_PROFILE,
      [],
    );

    await persistSetupProfile(guestOf(sprite), DISABLED_NETWORK_PROFILE, {
      mutation: { started: false },
      expected: DISABLED_NETWORK_PROFILE,
      section: 'network',
    });

    expect(launcherRuns(sprite)).toBe(0);
    expect(sprite.stopService).not.toHaveBeenCalled();
    expect(sprite.deleteService).not.toHaveBeenCalled();
    expect(sprite.createService).not.toHaveBeenCalled();
  });

  it('should release the recorded network when the selection replaces it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-network-recorded-'),
    );
    const sprite = await workstation(directory.path, TAILSCALE_PROFILE, [
      tailscaled,
    ]);

    await persistSetupProfile(guestOf(sprite), DISABLED_NETWORK_PROFILE, {
      mutation: { started: false },
      expected: TAILSCALE_PROFILE,
      section: 'network',
    });

    expect(sprite.deleteService).toHaveBeenCalledWith('tailscaled');
    expect(launcherRuns(sprite)).toBe(1);
  });

  it('should release a stray daemon on a workstation whose profile records no network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-network-stray-'),
    );
    const sprite = await workstation(directory.path, DISABLED_NETWORK_PROFILE, [
      tailscaled,
    ]);

    await persistSetupProfile(guestOf(sprite), DISABLED_NETWORK_PROFILE, {
      mutation: { started: false },
      expected: DISABLED_NETWORK_PROFILE,
      section: 'network',
    });

    expect(sprite.deleteService).toHaveBeenCalledWith('tailscaled');
    expect(launcherRuns(sprite)).toBe(1);
  });

  it('should leave the daemon of a network the selection keeps', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-network-kept-'),
    );
    const sprite = await workstation(directory.path, TAILSCALE_PROFILE, [
      tailscaled,
    ]);

    await persistSetupProfile(guestOf(sprite), TAILSCALE_PROFILE, {
      mutation: { started: false },
      expected: TAILSCALE_PROFILE,
      section: 'network',
    });

    expect(sprite.deleteService).not.toHaveBeenCalled();
    expect(launcherRuns(sprite)).toBe(0);
  });
});
