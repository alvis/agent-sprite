import { describe, expect, it, vi } from 'vitest';

import { isNetworkEnrolled } from '#setup/recorded';

import { environmentOf } from '../fixtures/environment.js';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type { NetworkStatus } from '#drivers/networks/contracts';
import type { GuestEnvironment } from '#integrations/guest/environment/contracts';

const status = vi.hoisted(() => ({
  current: vi.fn<() => Promise<NetworkStatus>>(),
}));

vi.mock('#core/networks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#core/networks')>()),
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

    expect(await isNetworkEnrolled(guest, recorded, target)).toBe(false);
  });

  it('should report enrolment from the live daemon identity even when none is recorded', async () => {
    status.current.mockResolvedValueOnce({
      online: true,
      skipped: false,
      deviceId: 'nLIVE',
    });

    expect(
      await isNetworkEnrolled(
        guest,
        { ...recorded, networkIdentity: undefined },
        target,
      ),
    ).toBe(true);
  });

  it('should not ask the guest before initial installation or for an untargeted network', async () => {
    status.current.mockClear();

    expect([
      await isNetworkEnrolled(guest, undefined, target),
      await isNetworkEnrolled(guest, recorded, {
        ...target,
        isTargeted: false,
      }),
    ]).toEqual([false, false]);
    expect(status.current).not.toHaveBeenCalled();
  });
});
