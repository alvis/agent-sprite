import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  isNetworkEnrolled,
  unrecordedProfile,
  assertSameWorkstationKind,
  readSetupEnvironment,
} from '#application/setup/recorded';
import { defaultProfile } from '#domain/profile';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';
import { createFilesystemSprite, workstationOf } from '../../mocks/sprites';

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

describe('fn:unrecordedProfile', () => {
  it('should use defaults when provider metadata has no registered summary', () => {
    const { workstation } = workstationOf(
      createFilesystemSprite({ root: tmpdir() }),
    );

    expect(unrecordedProfile(dependencies, workstation)).toEqual(
      defaultProfile(dependencies.defaults),
    );
  });
});

describe('fn:assertSameWorkstationKind', () => {
  it('should reject a provider change while accepting the recorded agent', () => {
    expect(() =>
      assertSameWorkstationKind(DISABLED_NETWORK_PROFILE, {
        provider: 'fly-machine',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INPUT' }));
    expect(() =>
      assertSameWorkstationKind(DISABLED_NETWORK_PROFILE, { agent: 't3' }),
    ).not.toThrow();
  });
});

describe('fn:readSetupEnvironment', () => {
  it('should require full recovery when the guest has no installation record', async () => {
    const wired = {
      ...dependencies,
      guest: {
        ...dependencies.guest,
        environment: {
          ...dependencies.guest.environment,
          find: async () => undefined,
        },
      },
    } satisfies typeof dependencies;

    await expect(
      readSetupEnvironment(wired, guest, 'tools'),
    ).rejects.toMatchObject({ code: 'PREFLIGHT' });
    await expect(
      readSetupEnvironment(wired, guest, 'all'),
    ).resolves.toBeUndefined();
  });
});
