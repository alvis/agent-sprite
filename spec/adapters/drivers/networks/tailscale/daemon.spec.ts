import { describe, expect, it, vi } from 'vitest';

import {
  ensureTailnetDaemon,
  restoreTailnetDns,
  enrollTailnet,
} from '#adapters/drivers/networks/tailscale/daemon';
import { Secret } from '#kernel/secret';

import type {
  GuestChannel,
  GuestServiceControl,
} from '#application/ports/guest-channel';

const boundary = vi.hoisted(
  () =>
    ({
      runSessionCommand: vi.fn<
        typeof import('#adapters/guest/platform/session/channel').runSessionCommand
      >(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    }) satisfies Partial<
      typeof import('#adapters/guest/platform/session/channel')
    >,
);
vi.mock(
  '#adapters/guest/platform/session/channel',
  () =>
    boundary satisfies Partial<
      typeof import('#adapters/guest/platform/session/channel')
    >,
);
const services = {
  ensure: vi.fn<GuestServiceControl['ensure']>(async () => undefined),
} satisfies Partial<GuestServiceControl> as Partial<GuestServiceControl> as GuestServiceControl;
const guest = {
  services,
  exec: vi.fn<GuestChannel['exec']>(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  })),
  exists: vi.fn<GuestChannel['exists']>(async () => true),
  assertUnrestrictedNetwork: vi.fn<GuestChannel['assertUnrestrictedNetwork']>(
    async () => undefined,
  ),
} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

describe('Tailscale daemon lifecycle', () => {
  it('should invoke the installed launcher in DNS restoration mode', async () => {
    await restoreTailnetDns(guest);

    expect(vi.mocked(guest.exec).mock.calls).toEqual([
      [
        expect.objectContaining({
          program: '/bin/sh',
          arguments: expect.arrayContaining(['--restore']),
        }),
      ],
    ]);
  });

  it('should leave DNS untouched when no launcher is installed', async () => {
    vi.mocked(guest.exists).mockImplementationOnce(async () => false);

    await restoreTailnetDns(guest);

    expect(guest.exec).not.toHaveBeenCalled();
  });

  it('should register the daemon only after verifying TUN and unrestricted networking', async () => {
    await ensureTailnetDaemon(guest);

    expect(vi.mocked(services.ensure).mock.calls).toEqual([
      [expect.objectContaining({ name: 'tailscaled' })],
    ]);
    expect(vi.mocked(guest.exec).mock.calls).toEqual([
      [
        expect.objectContaining({
          program: '/usr/bin/test',
          arguments: ['-c', '/dev/net/tun'],
        }),
      ],
    ]);
  });

  it('should refuse to start the daemon when provider networking is restricted', async () => {
    const failure = new Error('restricted');
    vi.mocked(guest.assertUnrestrictedNetwork).mockRejectedValueOnce(failure);

    await expect(ensureTailnetDaemon(guest)).rejects.toBe(failure);
    expect(services.ensure).not.toHaveBeenCalled();
  });
});

describe('fn:enrollTailnet', () => {
  it('should deliver the enrollment key privately and select the requested exit and hostname', async () => {
    const authKey = Secret.fromHost('provider-api', 'enrollment-key');

    await enrollTailnet(guest, {
      authKey,
      selected: '100.64.0.1',
      hostname: 'workstation',
    });

    expect(boundary.runSessionCommand.mock.calls).toEqual([
      [
        guest,
        expect.objectContaining({
          arguments: expect.arrayContaining([
            '--exit-node=100.64.0.1',
            '--hostname=workstation',
          ]),
          timeoutMs: 120000,
        }),
        { kind: 'secret', value: authKey, as: 'shm-file' },
      ],
    ]);
  });
});
