import { describe, expect, it, vi } from 'vitest';

import { releaseTailscale } from '#adapters/drivers/networks/tailscale/release';

import type { NetworkReleaseParams } from '#application/ports/drivers';
import type {
  GuestChannel,
  GuestServiceControl,
} from '#application/ports/guest-channel';

const boundary = vi.hoisted(
  () =>
    ({
      restoreTailnetDns: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/daemon').restoreTailnetDns
      >(async () => undefined),
      inspectTailscale: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/status').inspectTailscale
      >(async () => ({
        deviceId: 'workstation',
        ip: '100.64.0.2',
        online: true,
        dnsReady: false,
        skipped: false,
      })),
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/daemon') &
        typeof import('#adapters/drivers/networks/tailscale/status')
    >,
);
vi.mock(
  '#adapters/drivers/networks/tailscale/daemon',
  () =>
    ({ restoreTailnetDns: boundary.restoreTailnetDns }) satisfies Partial<
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
const services = {
  stop: vi.fn<GuestServiceControl['stop']>(async () => true),
  remove: vi.fn<GuestServiceControl['remove']>(async () => undefined),
} satisfies Partial<GuestServiceControl> as Partial<GuestServiceControl> as GuestServiceControl;
const guest = {
  services,
} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
const recordIdentity = vi.fn<NetworkReleaseParams['recordIdentity']>(
  async () => undefined,
);
const service = { name: 'tailscaled', status: 'running', needs: [] } as const;

describe('fn:releaseTailscale', () => {
  it('should persist live identity and stop the daemon before unregistering it and restoring DNS', async () => {
    await releaseTailscale(guest, { service, recordIdentity });

    expect(recordIdentity.mock.calls).toEqual([
      [{ deviceId: 'workstation', ip: '100.64.0.2' }],
    ]);
    expect(vi.mocked(services.stop).mock.calls).toEqual([['tailscaled']]);
    expect(vi.mocked(services.remove).mock.calls).toEqual([['tailscaled']]);
    expect(boundary.restoreTailnetDns.mock.calls).toEqual([[guest]]);
  });

  it('should retain the daemon registration when stopping reports failure', async () => {
    vi.mocked(services.stop).mockImplementationOnce(async () => false);

    await expect(
      releaseTailscale(guest, { service, recordIdentity }),
    ).rejects.toThrow(/Tailscale.*stop/iu);
    expect(services.remove).not.toHaveBeenCalled();
    expect(boundary.restoreTailnetDns).not.toHaveBeenCalled();
  });

  it('should restore DNS without querying identity when no daemon is registered', async () => {
    await releaseTailscale(guest, { service: undefined, recordIdentity });

    expect(recordIdentity).not.toHaveBeenCalled();
    expect(services.remove).not.toHaveBeenCalled();
    expect(boundary.restoreTailnetDns.mock.calls).toEqual([[guest]]);
  });
});
