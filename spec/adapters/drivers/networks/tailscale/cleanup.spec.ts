import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertSafeTailnetTarget,
  removeStaleTailnetDevice,
} from '#adapters/drivers/networks/tailscale/cleanup';
import { CommandFault } from '#kernel/faults';

import { createFilesystemSprite, guestOf } from '../../../../mocks/sprites';

import type { NetworkStaleDeviceParams } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { TailnetStatus } from '#domain/observations/network';

const statuses = vi.hoisted(() => new WeakMap<GuestChannel, TailnetStatus>());
const boundary = vi.hoisted(
  () =>
    ({
      ensureTailnetDaemon: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/daemon').ensureTailnetDaemon
      >(async () => undefined),
      inspectTailscale: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/status').inspectTailscale
      >(async (guest) => statuses.get(guest) ?? LOGGED_OUT),
      resolveExitNode: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/api').resolveExitNode
      >(async () => ({
        id: 'home',
        name: 'home.example.ts.net',
        ip: '100.64.0.1',
      })),
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
      ensureTailnetDaemon: boundary.ensureTailnetDaemon,
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/daemon')
    >,
);

vi.mock(
  '#adapters/drivers/networks/tailscale/status',
  () =>
    ({
      inspectTailscale: boundary.inspectTailscale,
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
      findTailnetDevice: boundary.findTailnetDevice,
      resolveExitNode: boundary.resolveExitNode,
      deleteTailnetDevice: boundary.deleteTailnetDevice,
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

    expect(boundary.ensureTailnetDaemon).toHaveBeenCalledTimes(1);
    expect(boundary.deleteTailnetDevice.mock.calls).toEqual([
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

    expect(boundary.deleteTailnetDevice).not.toHaveBeenCalled();
  });

  it('should delete nothing when the tailnet no longer holds the recorded device', async () => {
    await removeStale({
      recorded: { ...recorded, deviceId: 'nMISSING1CNTRL' },
      management,
    });

    expect(boundary.deleteTailnetDevice).not.toHaveBeenCalled();
  });

  it('should do nothing without a recorded device or a management account', async () => {
    await removeStale({ recorded: {}, management });
    await removeStale({ recorded, management: { credential: 'tskey-api' } });
    await removeStale({ recorded });

    expect(boundary.ensureTailnetDaemon).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new CommandFault({ code: 'AUTH', message: 'returned 403' }),
      code: 'AUTH',
    },
    { error: new Error('connection reset'), code: 'PROVIDER' },
  ])(
    'should fail naming the stale device when deletion fails with $code',
    async ({ error, code }) => {
      boundary.deleteTailnetDevice.mockRejectedValueOnce(error);

      const failure = await removeStale({ recorded, management }).catch(
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        constructor: CommandFault,
        code,
        message: expect.stringContaining('box.example.ts.net (nSTALE1CNTRL)'),
      });
    },
  );
});

describe('fn:assertSafeTailnetTarget', () => {
  it.each([
    { identity: { ...LOGGED_OUT, deviceId: 'self', exitNode: 'self' } },
    {
      identity: { ...LOGGED_OUT, deviceId: 'home' },
      management,
      exitNode: 'home',
    },
    {
      identity: { ...LOGGED_OUT, deviceId: 'workstation', ip: '100.64.0.1' },
      management,
      exitNode: 'home',
    },
  ])(
    'should reject deletion when the selected target is the exit node $identity',
    async (params) => {
      await expect(assertSafeTailnetTarget(params)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    },
  );

  it.each([
    { identity: { ...LOGGED_OUT, ...recorded }, management, exitNode: 'home' },
  ])(
    'should allow a target with no conflicting exit identity $identity',
    async (params) => {
      await expect(assertSafeTailnetTarget(params)).resolves.toBeUndefined();
    },
  );
  it('should avoid management requests when no exit node was selected', async () => {
    await expect(
      assertSafeTailnetTarget({
        identity: { ...LOGGED_OUT, ...recorded },
        management,
      }),
    ).resolves.toBeUndefined();

    expect(boundary.resolveExitNode).not.toHaveBeenCalled();
  });
});
