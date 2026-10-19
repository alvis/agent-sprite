import { describe, expect, it, vi } from 'vitest';

import { isNetworkEnrolled } from '#application/setup/recorded';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';

import type { GuestChannel } from '#application/ports/guest-channel';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { NetworkStatus } from '#domain/observations/network';

const status = vi.hoisted(() => ({
  current: vi.fn<() => Promise<NetworkStatus>>(),
}));

vi.mock('#application/catalog/networks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#application/catalog/networks')>()),
  networkDriver: () => ({ status: status.current }),
}));

const guest =
  {} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
const recorded: GuestEnvironment = environmentOf(DISABLED_NETWORK_PROFILE, {
  networkIdentity: { network: 'none', deviceId: 'nOLD' },
});
const target = { isTargeted: true, profile: DISABLED_NETWORK_PROFILE };

describe('fn:isNetworkEnrolled', () => {
  it('should not treat a recorded device as enrolment when the live daemon reports none', async () => {
    status.current.mockResolvedValueOnce({ online: false, skipped: false });

    expect(
      await isNetworkEnrolled(dependencies, {
        guest,
        environment: recorded,
        target,
      }),
    ).toBe(false);
  });

  it('should report enrolment from the live daemon identity even when none is recorded', async () => {
    status.current.mockResolvedValueOnce({
      online: true,
      skipped: false,
      deviceId: 'nLIVE',
    });

    expect(
      await isNetworkEnrolled(dependencies, {
        guest,
        environment: { ...recorded, networkIdentity: undefined },
        target,
      }),
    ).toBe(true);
  });

  it('should not ask the guest before initial installation or for an untargeted network', async () => {
    status.current.mockClear();

    expect([
      await isNetworkEnrolled(dependencies, {
        guest,
        environment: undefined,
        target,
      }),
      await isNetworkEnrolled(dependencies, {
        guest,
        environment: recorded,
        target: {
          ...target,
          isTargeted: false,
        },
      }),
    ]).toEqual([false, false]);
    expect(status.current).not.toHaveBeenCalled();
  });
});
