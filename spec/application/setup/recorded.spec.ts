import { describe, expect, it, vi } from 'vitest';

import { isNetworkEnrolled } from '#application/setup/recorded';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';

import type { RegisteredNetwork } from '#application/catalog/networks';
import type { DriverRegistry } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { NetworkStatus } from '#domain/observations/network';

const guest =
  {} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
const recorded: GuestEnvironment = environmentOf(DISABLED_NETWORK_PROFILE, {
  networkIdentity: { network: 'none', deviceId: 'nOLD' },
});
const target = { isTargeted: true, profile: DISABLED_NETWORK_PROFILE };

describe('fn:isNetworkEnrolled', () => {
  it('should not treat a recorded device as enrolment when the live daemon reports none', async () => {
    const registry = registryWithStatus({ online: false, skipped: false });

    expect(
      await isNetworkEnrolled(
        { registry },
        {
          guest,
          environment: recorded,
          target,
        },
      ),
    ).toBe(false);
  });

  it('should report enrolment from the live daemon identity even when none is recorded', async () => {
    const registry = registryWithStatus({
      online: true,
      skipped: false,
      deviceId: 'nLIVE',
    });

    expect(
      await isNetworkEnrolled(
        { registry },
        {
          guest,
          environment: environmentOf(DISABLED_NETWORK_PROFILE),
          target,
        },
      ),
    ).toBe(true);
  });

  it('should not ask the guest before initial installation or for an untargeted network', async () => {
    const registry = registryWithStatus({ online: false, skipped: false });

    expect([
      await isNetworkEnrolled(
        { registry },
        {
          guest,
          environment: undefined,
          target,
        },
      ),
      await isNetworkEnrolled(
        { registry },
        {
          guest,
          environment: recorded,
          target: {
            ...target,
            isTargeted: false,
          },
        },
      ),
    ]).toEqual([false, false]);
    expect(registry.networks.none.status).not.toHaveBeenCalled();
  });
});

/**
 * creates an isolated registry with the requested live network status
 * @param networkStatus the immutable status returned by the network driver
 * @returns a registry whose network status mock belongs to one test
 */
function registryWithStatus(networkStatus: NetworkStatus): DriverRegistry {
  return {
    ...dependencies.registry,
    networks: {
      ...dependencies.registry.networks,
      none: {
        ...dependencies.registry.networks.none,
        status: vi.fn<RegisteredNetwork['status']>(async () => networkStatus),
      } satisfies RegisteredNetwork,
    },
  } satisfies DriverRegistry;
}
