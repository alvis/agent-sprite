import { describe, expect, it, vi } from 'vitest';

import { enrollTailscale } from '#adapters/drivers/networks/tailscale/enroll';
import { Secret } from '#kernel/secret';

import type { NetworkEnrollParams } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { TailnetStatus } from '#domain/observations/network';

const statuses = vi.hoisted(() => new WeakMap<GuestChannel, TailnetStatus>());
const boundary = vi.hoisted(
  () =>
    ({
      ensureTailnetDaemon: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/daemon').ensureTailnetDaemon
      >(async () => undefined),
      enrollTailnet: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/daemon').enrollTailnet
      >(async () => undefined),
      inspectTailscale: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/status').inspectTailscale
      >(
        async (guest) =>
          statuses.get(guest) ?? {
            deviceId: 'workstation',
            ip: '100.64.0.2',
            online: true,
            skipped: false,
            dnsReady: true,
            exitNode: 'home',
            exitNodeIp: '100.64.0.1',
            routeDevice: 'tailscale0',
            egressIp: '198.51.100.1',
          },
      ),
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/daemon') &
        typeof import('#adapters/drivers/networks/tailscale/status')
    >,
);
vi.mock(
  '#adapters/drivers/networks/tailscale/daemon',
  () =>
    ({
      ensureTailnetDaemon: boundary.ensureTailnetDaemon,
      enrollTailnet: boundary.enrollTailnet,
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/daemon')
    >,
);
vi.mock(
  '#adapters/drivers/networks/tailscale/status',
  () =>
    ({ inspectTailscale: boundary.inspectTailscale }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/status')
    >,
);
const guest = {
  exec: vi.fn<GuestChannel['exec']>(async () => ({
    stdout: JSON.stringify({ Self: { ID: 'existing' } }),
    stderr: '',
    exitCode: 0,
  })),
} satisfies Partial<GuestChannel>;
const recordIdentity = vi.fn<NetworkEnrollParams['recordIdentity']>(
  async () => undefined,
);
const enrollment = { hostname: 'workstation', recordIdentity };

describe('fn:enrollTailscale', () => {
  it.each([
    { exitNode: 'home', selected: 'home' },
    {
      exitNode: { id: 'home', name: 'home', ip: '100.64.0.1' },
      selected: '100.64.0.1',
    },
    { selected: '' },
  ])(
    'should update an enrolled device to exit $selected and persist live identity',
    async ({ selected, ...options }) => {
      await enrollTailscale(guest as Partial<GuestChannel> as GuestChannel, {
        ...enrollment,
        ...options,
      });

      expect(recordIdentity.mock.calls).toEqual([
        [{ deviceId: 'workstation', ip: '100.64.0.2' }],
      ]);
      expect(
        guest.exec.mock.calls.map(([command]) => command.arguments),
      ).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([`--exit-node=${selected}`]),
        ]),
      );
      expect(boundary.enrollTailnet).not.toHaveBeenCalled();
    },
  );
});

describe('Tailscale registration', () => {
  it.each([null, { Self: null }, { Self: {} }])(
    'should enroll an unregistered native status %j with the private key',
    async (native) => {
      const channel = {
        exec: vi.fn<GuestChannel['exec']>(async () => ({
          stdout: JSON.stringify(native),
          stderr: '',
          exitCode: 0,
        })),
      } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
      const credential = Secret.fromHost('provider-api', 'enrollment-key');

      await enrollTailscale(channel, {
        ...enrollment,
        credential,
        exitNode: '100.64.0.1',
      });

      expect(recordIdentity.mock.calls).toEqual([
        [{ deviceId: 'workstation', ip: '100.64.0.2' }],
      ]);
      expect(boundary.enrollTailnet.mock.calls).toEqual([
        [
          channel,
          {
            authKey: credential,
            selected: '100.64.0.1',
            hostname: 'workstation',
          },
        ],
      ]);
    },
  );

  it('should require an enrollment credential after the native status command fails', async () => {
    guest.exec.mockImplementationOnce(async () => ({
      stdout: '',
      stderr: 'not registered',
      exitCode: 1,
    }));

    await expect(
      enrollTailscale(
        guest as Partial<GuestChannel> as GuestChannel,
        enrollment,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('key') });
    expect(recordIdentity).not.toHaveBeenCalled();
  });
});

describe('Tailscale readiness', () => {
  it.each([
    { overrides: { online: false }, error: /connectivity/iu },
    { overrides: { exitNode: '' }, error: /readiness/iu },
    { overrides: { routeDevice: 'eth0' }, error: /readiness/iu },
    { overrides: { dnsReady: false }, error: /readiness/iu },
    { overrides: { egressIp: '' }, error: /readiness/iu },
    {
      overrides: { exitNodeIp: '100.64.0.99' },
      error: /different exit node/iu,
    },
  ])(
    'should not persist an identity when live readiness fails %j',
    async ({ overrides, error }) => {
      const channel = { ...guest } as Partial<GuestChannel> as GuestChannel;
      statuses.set(channel, {
        deviceId: 'workstation',
        ip: '100.64.0.2',
        online: true,
        skipped: false,
        dnsReady: true,
        exitNode: 'home',
        exitNodeIp: '100.64.0.1',
        routeDevice: 'tailscale0',
        egressIp: '198.51.100.1',
        ...overrides,
      });

      await expect(
        enrollTailscale(channel, { ...enrollment, exitNode: '100.64.0.1' }),
      ).rejects.toThrow(error);
      expect(recordIdentity).not.toHaveBeenCalled();
    },
  );
});
