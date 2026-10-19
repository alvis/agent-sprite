import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { none } from '#adapters/drivers/networks/none';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { setupNetwork } from '#application/setup/network';

import { revealSecret } from '#kernel/secret';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies } from '../../mocks/dependencies';
import {
  createFilesystemSprite,
  guestOf,
  workstationOf,
} from '../../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type { ResolvedInputs } from '#application/input/types';
import type { NetworkDriver } from '#application/ports/drivers';
import type { SetupContext } from '#application/setup/context';
import type {
  NetworkStatus,
  GuestNetworkIdentity,
} from '#domain/observations/network';
import type { ServiceDefinition } from '#domain/services';

/** a network that runs a daemon but takes no caller-side inputs and installs nothing */
const daemonOnly = vi.hoisted<{ current: unknown }>(() => ({
  current: undefined,
}));

vi.mock('#application/catalog/networks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#application/catalog/networks')>()),
  networkDriver: () => daemonOnly.current,
}));

/** the daemon the observed networks run */
const DAEMON: ServiceDefinition = {
  name: 'netd',
  command: '/usr/bin/netd',
  arguments: [],
  account: 'root',
  needs: [],
};

/**
 * records a set-up workstation whose installed network runs the observed
 * daemon, so network setup enrols it without running the plan again
 * @param sprite sprite of the workstation
 * @param identity identity the environment records for the device
 */
async function recordNetwork(
  sprite: Sprite,
  identity?: GuestNetworkIdentity,
): Promise<void> {
  const environment = environmentOf(DISABLED_NETWORK_PROFILE, {
    network: {
      id: 'none',
      daemon: DAEMON.name,
      launcher: {
        stateDirectory: '/opt/open-agent/netd',
        socket: '/run/netd.sock',
        tun: 'netd0',
      },
    },
    ...(identity && { networkIdentity: identity }),
  });
  await sprite.filesystem().writeFile(
    ENVIRONMENT_PATH,
    JSON.stringify({
      ...environment,
      services: [...environment.services, DAEMON],
    }),
  );
}

/** a network with caller-side inputs whose enrolment and stale-device removal are observed */
const OBSERVED_INPUTS: NonNullable<NetworkDriver['inputs']> = {
  account: { environment: 'NET_ACCOUNT', prompt: 'Account', flag: '--account' },
  management: {
    environment: 'NET_KEY',
    prompt: 'Key',
    flag: '--key',
    store: 'net',
  },
  enrollment: { environment: 'NET_AUTH_KEY', flag: '--auth-key' },
  exitNode: { environment: 'NET_EXIT', prompt: 'Exit', flag: '--exit' },
};

/**
 * runs network setup against a guest whose environment records the given device
 * @param params recorded device identity, enrolment state and the observed driver steps
 * @param params.identity identity the environment records for the device
 * @param params.enrolled whether the live daemon reported a device before setup
 * @returns the observed driver calls in the order they happened
 */
async function runObservedSetup(params: {
  identity?: GuestNetworkIdentity;
  enrolled: boolean;
}): Promise<string[]> {
  const calls: string[] = [];
  daemonOnly.current = {
    ...none,
    id: 'none',
    displayName: 'Observed',
    inputs: OBSERVED_INPUTS,
    daemon: DAEMON,
    issueCredential: async () => {
      calls.push('issue');

      return Promise.resolve('minted-key');
    },
    removeStaleDevice: async (_guest, stale) => {
      calls.push(
        `remove:${stale.recorded.deviceId}:${stale.management?.credential}`,
      );

      return Promise.resolve();
    },
    enroll: async (_guest, enrollment) => {
      calls.push(
        `enroll:${enrollment.credential ? revealSecret(enrollment.credential) : ''}`,
      );

      return Promise.resolve();
    },
    status: async () => Promise.resolve({ online: true, skipped: false }),
  } satisfies NetworkDriver<'none'>;
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-setup-observed-'),
  );
  const sprite = createFilesystemSprite({ root: directory.path });
  await recordNetwork(sprite, params.identity);
  const input: ResolvedInputs = {
    profile: DISABLED_NETWORK_PROFILE,
    runtimeEnv: {},
    sources: {},
    missing: [],
    networkKey: 'api-key',
    networkAccount: 'example.ts.net',
  };
  const context: SetupContext = {
    ...workstationOf(sprite),
    options: {},
    input,
    profile: DISABLED_NETWORK_PROFILE,
    persistsProfile: false,
    isReleaseChanged: false,
    networkEnrolled: params.enrolled,
    mutation: { started: false },
  };

  await setupNetwork(dependencies, guestOf(sprite), context);

  return calls;
}

describe('fn:setupNetwork', () => {
  it('should enroll a network that has a daemon and no inputs without a credential', async () => {
    const status: NetworkStatus = { online: true, skipped: false };
    const enroll = vi.fn<NetworkDriver['enroll']>(async () =>
      Promise.resolve(),
    );
    daemonOnly.current = {
      ...none,
      id: 'none',
      displayName: 'Daemon only',
      daemon: DAEMON,
      enroll,
      status: async () => Promise.resolve(status),
    } satisfies NetworkDriver<'none'>;
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-daemon-only-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await recordNetwork(sprite);
    const context: SetupContext = {
      ...workstationOf(sprite),
      options: {},
      input: {
        profile: DISABLED_NETWORK_PROFILE,
        runtimeEnv: {},
        sources: {},
        missing: [],
      },
      profile: DISABLED_NETWORK_PROFILE,
      persistsProfile: false,
      isReleaseChanged: false,
      networkEnrolled: false,
      mutation: { started: false },
    };

    const result = await setupNetwork(dependencies, guestOf(sprite), context);

    expect(result).toEqual({
      network: { status: 'configured', exitNode: undefined },
    });
    expect(enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credential: undefined }),
    );
  });

  it('should delete the recorded device before enrolling a logged-out guest with a freshly minted key', async () => {
    const calls = await runObservedSetup({
      identity: { network: 'none', deviceId: 'nOLD', ip: '100.64.0.9' },
      enrolled: false,
    });

    expect(calls).toEqual([
      'issue',
      'remove:nOLD:api-key',
      'enroll:minted-key',
    ]);
  });

  it('should leave the recorded device alone when the live guest is enrolled', async () => {
    const calls = await runObservedSetup({
      identity: { network: 'none', deviceId: 'nOLD', ip: '100.64.0.9' },
      enrolled: true,
    });

    expect(calls.map((call) => call.split(':')[0])).toEqual(['enroll']);
  });

  it('should not remove a device the environment recorded for another network', async () => {
    const calls = await runObservedSetup({
      identity: { network: 'tailscale', deviceId: 'nOLD' },
      enrolled: false,
    });

    expect(calls.map((call) => call.split(':')[0])).toEqual([
      'issue',
      'enroll',
    ]);
  });
});
