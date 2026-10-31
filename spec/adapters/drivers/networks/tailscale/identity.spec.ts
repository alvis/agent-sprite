import { describe, expect, it, vi } from 'vitest';

import { identifyTailnetDevice } from '#adapters/drivers/networks/tailscale/identity';

import type { GuestChannel } from '#application/ports/guest-channel';

const guest = {
  exists: vi.fn<GuestChannel['exists']>(async () => true),
  exec: vi.fn<GuestChannel['exec']>(async () => ({
    stdout: JSON.stringify({ Self: { ID: 'live', Online: true } }),
    stderr: '',
    exitCode: 0,
  })),
} satisfies Partial<GuestChannel>;

describe('fn:identifyTailnetDevice', () => {
  it('should prefer captured live identity to persisted identity', async () => {
    expect(
      await identifyTailnetDevice(
        guest as Partial<GuestChannel> as GuestChannel,
        { identity: { deviceId: 'old' } },
      ),
    ).toMatchObject({ deviceId: 'live', online: true, skipped: false });
  });

  it('should retain persisted identity when native status cannot be decoded', async () => {
    guest.exec.mockImplementationOnce(async () => ({
      stdout: '{',
      stderr: '',
      exitCode: 0,
    }));

    expect(
      await identifyTailnetDevice(
        guest as Partial<GuestChannel> as GuestChannel,
        { identity: { deviceId: 'old', ip: '100.64.0.2' } },
      ),
    ).toEqual({
      deviceId: 'old',
      ip: '100.64.0.2',
      online: false,
      dnsReady: false,
      skipped: true,
    });
  });
});
