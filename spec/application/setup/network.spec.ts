import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { none } from '#adapters/drivers/networks/none';
import { debianFamily } from '#adapters/guest/os/debian/family';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { disableNetwork } from '#application/setup/disable-network';
import { setupNetwork, verifySetupExitNode } from '#application/setup/network';
import { registry } from '#composition/registry';

import { revealSecret } from '#kernel/secret';

import { environmentOf } from '../../fixtures/environment';
import {
  DISABLED_NETWORK_PROFILE,
  profileWith,
  TAILSCALE_PROFILE,
} from '../../fixtures/profile';
import { dependencies } from '../../mocks/dependencies';
import { standInSession } from '../../mocks/session';
import {
  createFilesystemSprite,
  guestOf,
  holdServices,
  workstationOf,
} from '../../mocks/sprites';

import type { ServiceWithState, Sprite } from '@fly/sprites';

import type { NetworkWithDaemon } from '#application/catalog/networks';
import type { ResolvedInputs } from '#application/input/types';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { DriverRegistry, NetworkDriver } from '#application/ports/drivers';
import type { GuestMechanics } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { SetupStep } from '#application/ports/plan';
import type { SetupSession } from '#application/ports/session';
import type { SetupContext } from '#application/setup/context';
import type { GuestEnvironment } from '#domain/observations/environment';
import type {
  NetworkStatus,
  GuestNetworkIdentity,
} from '#domain/observations/network';
import type { WorkstationProfile } from '#domain/profile';
import type { ServiceDefinition } from '#domain/services';

interface InstallationPlanBoundaryParams {
  context: SetupContext;
  guest: GuestChannel;
  installed: GuestEnvironment;
}

interface InstallationPlanBoundary {
  guest: GuestMechanics;
  run: ReturnType<typeof vi.fn<GuestMechanics['plan']['run']>>;
}

/** the daemon the observed networks run */
const DAEMON: ServiceDefinition = {
  name: 'netd',
  command: '/usr/bin/netd',
  arguments: [],
  account: 'root',
  needs: [],
};

/** an active network and exit route whose removal must change the profile */
const ACTIVE_PROFILE = profileWith({
  network: true,
  exitNode: true,
  cliproxyapi: false,
});

/**
 * supplies one test's network driver without replacing the catalog module
 * @param network driver observed through the guest boundary
 * @param guest guest plan and session mechanics for this case
 * @returns dependencies with the selected network driver and guest mechanics
 */
function withTailscale(
  network: DriverRegistry['networks']['tailscale'],
  guest: GuestMechanics = dependencies.guest,
): Pick<ApplicationDependencies, 'registry' | 'guest'> {
  return {
    registry: {
      ...dependencies.registry,
      networks: { ...dependencies.registry.networks, tailscale: network },
    },
    guest,
  };
}

/**
 * records a set-up workstation whose installed network runs the observed
 * daemon, so network setup enrols it without running the plan again
 * @param sprite sprite of the workstation
 * @param identity identity the environment records for the device
 * @param profile selected profile whose network was installed
 */
async function recordNetwork(
  sprite: Sprite,
  identity?: GuestNetworkIdentity,
  profile: WorkstationProfile = TAILSCALE_PROFILE,
): Promise<void> {
  const environment = environmentOf(profile, {
    network: {
      id: profile.network,
      daemon: DAEMON.name,
      launcher: {
        stateDirectory: '/opt/open-agent/netd',
        socket: '/run/netd.sock',
        tun: 'netd0',
      },
    },
    networkIdentity: identity,
  });
  await sprite.filesystem().writeFile(
    ENVIRONMENT_PATH,
    JSON.stringify({
      ...environment,
      services: [...environment.services, DAEMON],
    }),
  );
}

/**
 * a selected workstation whose setup choices can vary independently
 * @param sprite the guest whose workstation is selected
 * @param overrides setup choices that differ from the default
 * @returns the selected setup context
 */
function setupContext(
  sprite: Sprite,
  overrides: Partial<
    Pick<SetupContext, 'input' | 'profile' | 'networkEnrolled'>
  > = {},
): SetupContext {
  return {
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
    ...overrides,
  };
}

/**
 * keeps installation real while controlling guest plan, session and provider effects
 * @param params selected context, guest and installed environment
 * @param params.context setup context that owns the connection
 * @param params.guest guest filesystem and command boundary
 * @param params.installed environment the real installation reads
 * @returns guest mechanics with the controlled plan runner
 */
function installationAtPlanBoundary({
  context,
  guest,
  installed,
}: InstallationPlanBoundaryParams): InstallationPlanBoundary {
  const session = standInSession(guest);
  context.connection = {
    ...session,
    open: async () => session,
    reopen: async () => session,
    lend: async () => session,
    close: async () => undefined,
    guest: async () => guest,
  } satisfies SetupSession;
  const environmentStep: SetupStep = {
    id: 'environment',
    component: 'environment',
    account: 'root',
    needs: [],
    apply: { argv: ['true'] },
    timeoutMs: 1000,
    critical: true,
    retry: 'never',
  };
  const run = vi.fn<GuestMechanics['plan']['run']>(async ({ steps }) => {
    if (steps.includes(environmentStep)) {
      await dependencies.guest.environment.write(guest, installed);
    }

    return { isComplete: true, steps: [] };
  });

  return {
    guest: {
      ...dependencies.guest,
      plan: {
        ...dependencies.guest.plan,
        assemble: async () => ({
          family: debianFamily,
          tools: [],
          resolutions: [],
          environment: installed,
          foundation: [],
          steps: [environmentStep],
          services: [],
        }),
        needsBottleProbe: () => false,
        run,
      },
      services: { installProvider: async () => undefined },
    },
    run,
  };
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
  const network = {
    ...registry.networks.tailscale,
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
    status: async () =>
      Promise.resolve({ online: true, skipped: false, dnsReady: true }),
  } satisfies DriverRegistry['networks']['tailscale'];
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-setup-observed-'),
  );
  const sprite = createFilesystemSprite({ root: directory.path });
  await recordNetwork(sprite, params.identity, TAILSCALE_PROFILE);
  const input: ResolvedInputs = {
    profile: TAILSCALE_PROFILE,
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
    profile: TAILSCALE_PROFILE,
    persistsProfile: false,
    isReleaseChanged: false,
    networkEnrolled: params.enrolled,
    mutation: { started: false },
  };

  await setupNetwork(withTailscale(network), guestOf(sprite), context);

  return calls;
}

describe('fn:setupNetwork', () => {
  it('should record readiness after switching from an installed daemon to no network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-disable-plan-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await sprite.filesystem().writeFile(
      ENVIRONMENT_PATH,
      JSON.stringify(
        environmentOf(TAILSCALE_PROFILE, {
          network: {
            id: 'tailscale',
            daemon: DAEMON.name,
            launcher: {
              stateDirectory: '/opt/open-agent/netd',
              socket: '/run/netd.sock',
              tun: 'netd0',
            },
          },
          services: [registry.agents[TAILSCALE_PROFILE.agent].service, DAEMON],
        }),
      ),
    );
    const guest = guestOf(sprite);
    const context = setupContext(sprite);
    const plan = installationAtPlanBoundary({
      context,
      guest,
      installed: environmentOf(DISABLED_NETWORK_PROFILE, {
        setup: { state: 'incomplete', skipped: [] },
      }),
    });

    const result = await setupNetwork(
      { registry: dependencies.registry, guest: plan.guest },
      guest,
      context,
    );

    expect(result).toEqual({
      network: { status: 'disabled', readiness: 'skipped' },
    });
    expect(
      plan.run.mock.calls.map(([{ steps }]) => steps.map(({ id }) => id)),
    ).toEqual([['environment'], []]);
    expect((await dependencies.guest.environment.read(guest)).setup.state).toBe(
      'ready',
    );
  });

  it.each([
    { enrollmentFails: false, expectedState: 'ready' },
    { enrollmentFails: true, expectedState: 'incomplete' },
  ] as const)(
    'should leave a newly installed daemon $expectedState after enrolment (fails=$enrollmentFails)',
    async ({ enrollmentFails, expectedState }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-setup-install-network-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      await sprite
        .filesystem()
        .writeFile(
          ENVIRONMENT_PATH,
          JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE)),
        );
      const guest = guestOf(sprite);
      const profile = TAILSCALE_PROFILE;
      const enroll = vi.fn<NetworkDriver['enroll']>(async () => {
        expect(
          (await dependencies.guest.environment.read(guest)).setup.state,
        ).toBe('incomplete');
        if (enrollmentFails) {
          throw new Error('enrolment refused');
        }
      });
      const network = {
        ...registry.networks.tailscale,
        daemon: DAEMON,
        enroll,
        status: async () => ({ online: true, skipped: false, dnsReady: true }),
      } satisfies DriverRegistry['networks']['tailscale'];
      const context = setupContext(sprite, {
        profile,
        input: {
          profile,
          runtimeEnv: {},
          sources: {},
          missing: [],
          networkAccount: 'example.ts.net',
        },
        networkEnrolled: true,
      });
      const plan = installationAtPlanBoundary({
        context,
        guest,
        installed: environmentOf(profile, {
          setup: { state: 'incomplete', skipped: [] },
          network: {
            id: 'tailscale',
            daemon: DAEMON.name,
            launcher: {
              stateDirectory: '/opt/open-agent/netd',
              socket: '/run/netd.sock',
              tun: 'netd0',
            },
          },
          services: [registry.agents[profile.agent].service, DAEMON],
        }),
      });

      const result = setupNetwork(
        withTailscale(network, plan.guest),
        guest,
        context,
      );

      if (enrollmentFails) {
        await expect(result).rejects.toThrow('enrolment refused');
      } else {
        await expect(result).resolves.toEqual({
          network: { status: 'configured', exitNode: undefined },
        });
      }
      expect(
        plan.run.mock.calls.map(([{ steps }]) => steps.map(({ id }) => id)),
      ).toEqual([['environment'], []]);
      expect(enroll).toHaveBeenCalledOnce();
      expect(
        (await dependencies.guest.environment.read(guest)).setup.state,
      ).toBe(expectedState);
    },
  );

  it('should leave a workstation without a network disabled without enrolling a device', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-no-network-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await sprite
      .filesystem()
      .writeFile(
        ENVIRONMENT_PATH,
        JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE)),
      );
    const context = setupContext(sprite);

    const result = await setupNetwork(dependencies, guestOf(sprite), context);

    expect(result).toEqual({
      network: { status: 'disabled', readiness: 'skipped' },
    });
    expect(context.mutation.started).toBe(false);
  });

  it.each([
    {
      name: 'account',
      account: undefined,
      exitNode: undefined,
      useExit: false,
    },
    {
      name: 'exit node',
      account: 'example.ts.net',
      exitNode: undefined,
      useExit: true,
    },
  ])(
    'should reject validated network inputs missing their $name before enrolment',
    async ({ account, exitNode, useExit }) => {
      const enroll = vi.fn<NetworkDriver['enroll']>(async () => undefined);
      const profile = useExit
        ? profileWith({ network: true, exitNode: true, cliproxyapi: false })
        : TAILSCALE_PROFILE;
      const network = {
        ...registry.networks.tailscale,
        displayName: 'Observed',
        inputs: OBSERVED_INPUTS,
        daemon: DAEMON,
        enroll,
      } satisfies DriverRegistry['networks']['tailscale'];
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-setup-missing-network-input-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      await recordNetwork(sprite, undefined, profile);
      const context = setupContext(sprite, {
        profile,
        input: {
          profile,
          runtimeEnv: {},
          sources: {},
          missing: [],
          networkAccount: account,
          exitNode,
        },
      });

      await expect(
        setupNetwork(withTailscale(network), guestOf(sprite), context),
      ).rejects.toThrow('Validated Observed inputs were unavailable');
      expect(enroll).not.toHaveBeenCalled();
      expect(context.mutation.started).toBe(false);
    },
  );

  it('should enroll a network that has a daemon and no inputs without a credential', async () => {
    const status: NetworkStatus = { online: true, skipped: false };
    const enroll = vi.fn<NetworkDriver['enroll']>(async () =>
      Promise.resolve(),
    );
    const network = {
      ...registry.networks.tailscale,
      displayName: 'Daemon only',
      inputs: undefined,
      tools: [],
      daemon: DAEMON,
      enroll,
      status: async () => Promise.resolve({ ...status, dnsReady: true }),
    } satisfies DriverRegistry['networks']['tailscale'];
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-daemon-only-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await recordNetwork(sprite, undefined, TAILSCALE_PROFILE);
    const context = setupContext(sprite, {
      profile: TAILSCALE_PROFILE,
      input: {
        profile: TAILSCALE_PROFILE,
        runtimeEnv: {},
        sources: {},
        missing: [],
      },
    });

    const result = await setupNetwork(
      withTailscale(network),
      guestOf(sprite),
      context,
    );

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
      identity: { network: 'tailscale', deviceId: 'nOLD', ip: '100.64.0.9' },
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
      identity: { network: 'tailscale', deviceId: 'nOLD', ip: '100.64.0.9' },
      enrolled: true,
    });

    expect(calls.map((call) => call.split(':')[0])).toEqual(['enroll']);
  });

  it('should not remove a device the environment recorded for another network', async () => {
    const calls = await runObservedSetup({
      identity: { network: 'none', deviceId: 'nOLD' },
      enrolled: false,
    });

    expect(calls.map((call) => call.split(':')[0])).toEqual([
      'issue',
      'enroll',
    ]);
  });

  it.each([
    { matched: true, verified: true, expected: 'Office Gateway' },
    { matched: true, verified: false, expected: 'office' },
    { matched: false, verified: true, expected: undefined },
  ])(
    'should require the selected exit route to be active (matched=$matched, verified=$verified)',
    async ({ matched, verified, expected }) => {
      const enroll = vi.fn<NetworkDriver['enroll']>(async () => undefined);
      const matchesExitNode = vi.fn<NetworkDriver['matchesExitNode']>(
        () => matched,
      );
      const network = {
        ...registry.networks.tailscale,
        displayName: 'Observed',
        daemon: DAEMON,
        inputs: OBSERVED_INPUTS,
        enroll,
        status: async () => ({ online: true, skipped: false, dnsReady: true }),
        matchesExitNode,
      } satisfies DriverRegistry['networks']['tailscale'];
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-setup-exit-route-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const profile = profileWith({
        network: true,
        exitNode: true,
        cliproxyapi: false,
      });
      await recordNetwork(sprite, undefined, profile);
      const context = setupContext(sprite, {
        profile,
        input: {
          profile,
          runtimeEnv: {},
          sources: {},
          missing: [],
          networkAccount: 'example.ts.net',
          exitNode: 'office',
        },
        networkEnrolled: true,
      });
      if (verified) {
        context.verifiedExitNode = {
          id: 'node-1',
          name: 'Office Gateway',
          ip: '100.64.0.10',
        };
      }

      const result = setupNetwork(
        withTailscale(network),
        guestOf(sprite),
        context,
      );

      if (matched) {
        await expect(result).resolves.toEqual({
          network: { status: 'configured', exitNode: expected },
        });
      } else {
        await expect(result).rejects.toThrow(
          'The selected exit node does not match current Observed status',
        );
      }
      expect(enroll).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          exitNode: verified ? '100.64.0.10' : 'office',
        }),
      );
      expect(matchesExitNode).toHaveBeenCalledWith(
        verified ? '100.64.0.10' : 'office',
        { online: true, skipped: false, dnsReady: true },
      );
      expect(context.mutation.started).toBe(true);
    },
  );
});

describe('fn:verifySetupExitNode', () => {
  it('should resolve an enabled exit node using the selected network account and management key', async () => {
    const node = { id: 'node-1', name: 'office', ip: '100.64.0.10' };
    const verifyExitNode = vi.fn<NetworkDriver['verifyExitNode']>(async () =>
      Promise.resolve(node),
    );
    const network = {
      ...registry.networks.tailscale,
      supportsExitNode: true,
      verifyExitNode,
    } satisfies DriverRegistry['networks']['tailscale'];
    const profile = {
      ...TAILSCALE_PROFILE,
      options: {
        ...TAILSCALE_PROFILE.options,
        isExitNodeEnabled: true,
      },
    };

    const selected = await verifySetupExitNode(
      withTailscale(network),
      {
        profile,
        runtimeEnv: {},
        sources: {},
        missing: [],
        networkAccount: 'example.ts.net',
        networkKey: 'api-key',
        exitNode: 'office',
      },
      profile,
    );

    expect(selected).toEqual(node);
    expect(verifyExitNode).toHaveBeenCalledWith(
      { account: 'example.ts.net', credential: 'api-key' },
      'office',
    );
  });

  it.each([
    {
      reason: 'unsupported network',
      supportsExitNode: false,
      enabled: true,
      account: 'example.ts.net',
      selector: 'office',
    },
    {
      reason: 'disabled route',
      supportsExitNode: true,
      enabled: false,
      account: 'example.ts.net',
      selector: 'office',
    },
    {
      reason: 'missing account',
      supportsExitNode: true,
      enabled: true,
      account: undefined,
      selector: 'office',
    },
    {
      reason: 'missing selector',
      supportsExitNode: true,
      enabled: true,
      account: 'example.ts.net',
      selector: undefined,
    },
  ])(
    'should not verify an exit node with $reason',
    async ({ supportsExitNode, enabled, account, selector }) => {
      const verifyExitNode = vi.fn<NetworkDriver['verifyExitNode']>(async () =>
        Promise.resolve({ id: 'node-1', name: 'office', ip: '100.64.0.10' }),
      );
      const network = {
        ...registry.networks.tailscale,
        supportsExitNode,
        verifyExitNode,
      } satisfies DriverRegistry['networks']['tailscale'];
      const profile = {
        ...TAILSCALE_PROFILE,
        options: {
          ...TAILSCALE_PROFILE.options,
          isExitNodeEnabled: enabled,
        },
      };

      const selected = await verifySetupExitNode(
        withTailscale(network),
        {
          profile,
          runtimeEnv: {},
          sources: {},
          missing: [],
          networkAccount: account,
          networkKey: 'api-key',
          exitNode: selector,
        },
        profile,
      );

      expect(selected).toBeUndefined();
      expect(verifyExitNode).not.toHaveBeenCalled();
    },
  );
});

describe('fn:disableNetwork', () => {
  it.each([
    {
      name: 'running dependent',
      daemonPresent: true,
      agentPresent: true,
      status: 'running',
      needsDaemon: true,
      stops: true,
      removes: true,
    },
    {
      name: 'running independent',
      daemonPresent: true,
      agentPresent: true,
      status: 'running',
      needsDaemon: false,
      stops: true,
      removes: false,
    },
    {
      name: 'stopped dependent',
      daemonPresent: true,
      agentPresent: true,
      status: 'stopped',
      needsDaemon: true,
      stops: false,
      removes: true,
    },
    {
      name: 'missing daemon',
      daemonPresent: false,
      agentPresent: true,
      status: 'running',
      needsDaemon: true,
      stops: false,
      removes: false,
    },
    {
      name: 'missing agent',
      daemonPresent: true,
      agentPresent: false,
      status: 'running',
      needsDaemon: true,
      stops: false,
      removes: false,
    },
  ] as const)(
    'should release a network and detach its $name service safely',
    async ({
      daemonPresent,
      agentPresent,
      status,
      needsDaemon,
      stops,
      removes,
    }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-disable-network-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      await sprite
        .filesystem()
        .writeFile(
          ENVIRONMENT_PATH,
          JSON.stringify(environmentOf(ACTIVE_PROFILE)),
        );
      const services = holdServices(sprite);
      const agentName = registry.agents[ACTIVE_PROFILE.agent].service.name;
      if (daemonPresent) {
        services.set(DAEMON.name, {
          name: DAEMON.name,
          cmd: DAEMON.command,
          args: [],
          needs: [],
          state: { name: DAEMON.name, status: 'running' },
        } satisfies ServiceWithState);
      }
      if (agentPresent) {
        services.set(agentName, {
          name: agentName,
          cmd: '/bin/true',
          args: [],
          needs: needsDaemon ? [DAEMON.name] : [],
          state: { name: agentName, status },
        } satisfies ServiceWithState);
      }
      const release = vi.fn<NetworkDriver['release']>(async () => undefined);
      const network = {
        ...none,
        id: 'tailscale',
        daemon: DAEMON,
        release,
      } satisfies NetworkWithDaemon;
      const guest = guestOf(sprite);

      await expect(
        disableNetwork(
          {
            declarations: registry,
            environment: dependencies.guest.environment,
          },
          guest,
          network,
        ),
      ).resolves.toBeUndefined();

      expect(
        vi.mocked(sprite.stopService).mock.calls.map(([name]) => name),
      ).toEqual(stops ? [agentName] : []);
      expect(
        vi.mocked(sprite.deleteService).mock.calls.map(([name]) => name),
      ).toEqual(removes ? [agentName] : []);
      expect(release).toHaveBeenCalledWith(
        guest,
        expect.objectContaining({
          service: daemonPresent
            ? expect.objectContaining({ name: DAEMON.name })
            : undefined,
        }),
      );
      const recorded = await dependencies.guest.environment.read(guest);
      expect(recorded.profile).toMatchObject({
        network: 'none',
        options: { isExitNodeEnabled: false },
      });
    },
  );

  it('should preserve the selected network when its running agent refuses to stop', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-disable-stop-failure-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await sprite
      .filesystem()
      .writeFile(
        ENVIRONMENT_PATH,
        JSON.stringify(environmentOf(ACTIVE_PROFILE)),
      );
    const agentName = registry.agents[ACTIVE_PROFILE.agent].service.name;
    const services = holdServices(sprite);
    services.set(DAEMON.name, {
      name: DAEMON.name,
      cmd: DAEMON.command,
      args: [],
      needs: [],
      state: { name: DAEMON.name, status: 'running' },
    } satisfies ServiceWithState);
    services.set(agentName, {
      name: agentName,
      cmd: '/bin/true',
      args: [],
      needs: [DAEMON.name],
      state: { name: agentName, status: 'running' },
    } satisfies ServiceWithState);
    const guest = guestOf(sprite);
    vi.spyOn(guest.services, 'stop').mockResolvedValue(false);
    const release = vi.fn<NetworkDriver['release']>(async () => undefined);

    await expect(
      disableNetwork(
        { declarations: registry, environment: dependencies.guest.environment },
        guest,
        { ...none, id: 'tailscale', daemon: DAEMON, release },
      ),
    ).rejects.toThrow('The agent service reported a stop failure');
    expect(release).not.toHaveBeenCalled();
    expect(
      (await dependencies.guest.environment.read(guest)).profile.network,
    ).toBe(ACTIVE_PROFILE.network);
  });
});
