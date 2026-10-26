import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { removeStaleTailnetDevice } from '#adapters/drivers/networks/tailscale/cleanup';
import { CommandFault } from '#kernel/faults';

import { createFilesystemSprite, guestOf } from '../../../../mocks/sprites';

import type { NetworkStaleDeviceParams } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { TailnetStatus } from '#domain/observations/network';

const statuses = vi.hoisted(() => new WeakMap<GuestChannel, TailnetStatus>());
const mocks = vi.hoisted(
  () =>
    ({
      ensureTailnetDaemon: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/daemon').ensureTailnetDaemon
      >(async () => undefined),
      inspectTailscale: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/status').inspectTailscale
      >(async (guest) => statuses.get(guest) ?? LOGGED_OUT),
      findTailnetDevice: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/api').findTailnetDevice
      >(async (_key, _tailnet, id) =>
        id === 'nSTALE1CNTRL' ? { name: 'box.example.ts.net' } : undefined,
      ),
      deleteTailnetDevice: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/api').deleteTailnetDevice
      >(async () => undefined),
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/daemon') &
        typeof import('#adapters/drivers/networks/tailscale/status') &
        typeof import('#adapters/drivers/networks/tailscale/api')
    >,
);

vi.mock(
  '#adapters/drivers/networks/tailscale/daemon',
  () =>
    ({
      ensureTailnetDaemon: mocks.ensureTailnetDaemon,
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/daemon')
    >,
);

vi.mock(
  '#adapters/drivers/networks/tailscale/status',
  () =>
    ({
      inspectTailscale: mocks.inspectTailscale,
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/status')
    >,
);

vi.mock(
  '#adapters/drivers/networks/tailscale/api',
  async (importOriginal) =>
    ({
      ...(await importOriginal<
        typeof import('#adapters/drivers/networks/tailscale/api')
      >()),
      findTailnetDevice: mocks.findTailnetDevice,
      deleteTailnetDevice: mocks.deleteTailnetDevice,
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/api')
    >,
);

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
 * @param status observed native status of the guest
 */
async function removeStale(
  params: NetworkStaleDeviceParams,
  status: TailnetStatus = LOGGED_OUT,
): Promise<void> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-stale-device-'),
  );
  const sprite = createFilesystemSprite({ root: directory.path });
  const guest = guestOf(sprite);
  statuses.set(guest, status);
  await removeStaleTailnetDevice(guest, params);
}

describe('fn:removeStaleTailnetDevice', () => {
  it('should delete the recorded device of a logged-out guest that the tailnet still holds', async () => {
    await removeStale({ recorded, management });

    expect(mocks.ensureTailnetDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTailnetDevice.mock.calls).toEqual([
      ['tskey-api-test', 'nSTALE1CNTRL'],
    ]);
  });

  it('should leave the tailnet alone when the guest still holds a device', async () => {
    await removeStale(
      { recorded, management },
      {
        ...LOGGED_OUT,
        deviceId: 'nLIVE1CNTRL',
        online: true,
      },
    );

    expect(mocks.deleteTailnetDevice).not.toHaveBeenCalled();
  });

  it('should delete nothing when the tailnet no longer holds the recorded device', async () => {
    await removeStale({
      recorded: { ...recorded, deviceId: 'nMISSING1CNTRL' },
      management,
    });

    expect(mocks.deleteTailnetDevice).not.toHaveBeenCalled();
  });

  it('should do nothing without a recorded device or a management account', async () => {
    await removeStale({ recorded: {}, management });
    await removeStale({ recorded, management: { credential: 'tskey-api' } });
    await removeStale({ recorded });

    expect(mocks.ensureTailnetDaemon).not.toHaveBeenCalled();
  });

  it('should fail naming the stale device when the management key cannot delete it', async () => {
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
