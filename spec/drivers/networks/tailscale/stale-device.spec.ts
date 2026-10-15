import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { removeStaleTailnetDevice } from '#drivers/networks/tailscale/cleanup';
import { CommandFault } from '#errors';

import { createFilesystemSprite, guestOf } from '../../../mocks/sprites.js';

import type { NetworkStaleDeviceParams } from '#drivers/contracts';
import type { TailnetStatus } from '#drivers/networks/tailscale/types';

const mocks = vi.hoisted(() => ({
  ensureTailnetDaemon: vi.fn<() => Promise<void>>(),
  inspectTailscale: vi.fn<() => Promise<TailnetStatus>>(),
  findTailnetDevice: vi.fn<() => Promise<{ name: string } | undefined>>(),
  deleteTailnetDevice: vi.fn<(apiKey: string, id: string) => Promise<void>>(),
}));

vi.mock('#drivers/networks/tailscale/daemon', () => ({
  ensureTailnetDaemon: mocks.ensureTailnetDaemon,
}));

vi.mock('#drivers/networks/tailscale/status', () => ({
  inspectTailscale: mocks.inspectTailscale,
}));

vi.mock('#drivers/networks/tailscale/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#drivers/networks/tailscale/api')>()),
  findTailnetDevice: mocks.findTailnetDevice,
  deleteTailnetDevice: mocks.deleteTailnetDevice,
}));

const LOGGED_OUT: TailnetStatus = {
  online: false,
  dnsReady: false,
  skipped: false,
};
const management = { credential: 'tskey-api-test', account: 'example.ts.net' };
const recorded = { deviceId: 'nSTALE1CNTRL', ip: '100.64.0.9' };

/**
 * runs one stale-device removal against a throwaway guest
 * @param params recorded identity and management credential
 */
async function removeStale(params: NetworkStaleDeviceParams): Promise<void> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-stale-device-'),
  );
  const sprite = createFilesystemSprite({ root: directory.path });
  await removeStaleTailnetDevice(guestOf(sprite), params);
}

describe('fn:removeStaleTailnetDevice', () => {
  it('should delete the recorded device of a logged-out guest that the tailnet still holds', async () => {
    mocks.inspectTailscale.mockResolvedValueOnce(LOGGED_OUT);
    mocks.findTailnetDevice.mockResolvedValueOnce({
      name: 'box.example.ts.net',
    });
    mocks.deleteTailnetDevice.mockClear();

    await removeStale({ recorded, management });

    expect(mocks.ensureTailnetDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTailnetDevice.mock.calls).toEqual([
      ['tskey-api-test', 'nSTALE1CNTRL'],
    ]);
  });

  it('should leave the tailnet alone when the guest still holds a device', async () => {
    mocks.inspectTailscale.mockResolvedValueOnce({
      ...LOGGED_OUT,
      deviceId: 'nLIVE1CNTRL',
      online: true,
    });
    mocks.deleteTailnetDevice.mockClear();

    await removeStale({ recorded, management });

    expect(mocks.deleteTailnetDevice).not.toHaveBeenCalled();
  });

  it('should delete nothing when the tailnet no longer holds the recorded device', async () => {
    mocks.inspectTailscale.mockResolvedValueOnce(LOGGED_OUT);
    mocks.findTailnetDevice.mockResolvedValueOnce(undefined);
    mocks.deleteTailnetDevice.mockClear();

    await removeStale({ recorded, management });

    expect(mocks.deleteTailnetDevice).not.toHaveBeenCalled();
  });

  it('should do nothing without a recorded device or a management account', async () => {
    mocks.ensureTailnetDaemon.mockClear();

    await removeStale({ recorded: {}, management });
    await removeStale({ recorded, management: { credential: 'tskey-api' } });
    await removeStale({ recorded });

    expect(mocks.ensureTailnetDaemon).not.toHaveBeenCalled();
  });

  it('should fail naming the stale device when the management key cannot delete it', async () => {
    mocks.inspectTailscale.mockResolvedValueOnce(LOGGED_OUT);
    mocks.findTailnetDevice.mockResolvedValueOnce({
      name: 'box.example.ts.net',
    });
    mocks.deleteTailnetDevice.mockRejectedValueOnce(
      new CommandFault({ code: 'AUTH', message: 'returned 403' }),
    );

    const failure = await removeStale({ recorded, management }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommandFault);
    expect(failure).toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('box.example.ts.net (nSTALE1CNTRL)'),
    });
  });
});
