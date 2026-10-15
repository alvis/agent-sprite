import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { none } from '#drivers/networks/none/index';
import { setupNetwork } from '#setup/network';

import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  workstationOf,
} from '../mocks/sprites.js';

import type { NetworkDriver, NetworkStatus } from '#drivers/contracts';
import type { ResolvedInputs } from '#input/types';
import type { GuestNetworkIdentity } from '#integrations/guest/types';
import type { SetupContext } from '#setup/context';

/** a network that runs a daemon but takes no caller-side inputs and installs nothing */
const daemonOnly = vi.hoisted<{ current: unknown }>(() => ({
  current: undefined,
}));

vi.mock('#core/networks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#core/networks')>()),
  networkDriver: () => daemonOnly.current,
}));

vi.mock('#integrations/guest/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#integrations/guest/runtime')>()),
  installManagedServices: vi.fn(async () => Promise.resolve()),
}));

/** a network with caller-side inputs whose enrolment and stale-device removal are observed */
const OBSERVED_INPUTS: NonNullable<NetworkDriver['inputs']> = {
  account: { environment: 'NET_ACCOUNT', prompt: 'Account' },
  management: { environment: 'NET_KEY', prompt: 'Key', store: 'net' },
  enrollment: { environment: 'NET_AUTH_KEY' },
  exitNode: { environment: 'NET_EXIT', prompt: 'Exit' },
};

/**
 * runs network setup against a guest whose manifest records the given device
 * @param params recorded device identity, enrolment state and the observed driver steps
 * @param params.identity identity the manifest records for the device
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
    daemon: {
      name: 'netd',
      command: '/usr/bin/netd',
      arguments: [],
      account: 'root',
      needs: [],
    },
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
      calls.push(`enroll:${enrollment.credential}`);

      return Promise.resolve();
    },
    status: async () => Promise.resolve({ online: true, skipped: false }),
  } satisfies NetworkDriver<'none'>;
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-setup-observed-'),
  );
  const sprite = createFilesystemSprite({ root: directory.path });
  await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
  await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
    schema: 1,
    createdAt: '2026-10-09T00:00:00Z',
    installedVersions: {},
    profile: DISABLED_NETWORK_PROFILE,
    networkIdentity: params.identity,
  });
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
    initialInstallation: false,
    mutation: { started: false },
  };

  await setupNetwork(guestOf(sprite), context);

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
      daemon: {
        name: 'netd',
        command: '/usr/bin/netd',
        arguments: [],
        account: 'root',
        needs: [],
      },
      enroll,
      status: async () => Promise.resolve(status),
    } satisfies NetworkDriver<'none'>;
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-daemon-only-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      profile: DISABLED_NETWORK_PROFILE,
    });
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
      initialInstallation: false,
      mutation: { started: false },
    };

    const result = await setupNetwork(guestOf(sprite), context);

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

  it('should not remove a device the manifest recorded for another network', async () => {
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
