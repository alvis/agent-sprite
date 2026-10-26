import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  mergeMetadataLabels,
  SCHEMA_LABEL,
} from '#adapters/drivers/providers/sprite/labels';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { setupWorkstation } from '#application/setup';
import { isAgentReleaseChanged } from '#application/setup/release';
import { registry } from '#composition/registry';
import { summarizeProfile } from '#domain/recorded';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies, dependenciesWith } from '../../mocks/dependencies';
import {
  createFilesystemSprite,
  holdServices,
  providerOf,
  workstationOf,
} from '../../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type {
  AgentReleaseState,
  GuestMechanics,
} from '#application/ports/guest';
import type { Interaction } from '#application/ports/interaction';
import type { GuestInspection } from '#domain/observations/inspection';
import type { NativeConfigurationInspection } from '#domain/observations/native';
import type { WorkstationProfile } from '#domain/profile';
import type { StatusUpdate } from '#kernel/status';

import type { GuestExecute } from '../../mocks/sprites';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../../mocks/session'),
);
// Codex trusts its hooks through its app server, a guest process only the live specs run
vi.mock(
  '#adapters/drivers/harnesses/codex/hook-trust',
  () =>
    ({
      trustCodexHooks: vi.fn(async () => undefined),
    }) satisfies Pick<
      typeof import('#adapters/drivers/harnesses/codex/hook-trust'),
      'trustCodexHooks'
    >,
);

/** the pairing token the guest's T3 Code mints */
const PAIRING_TOKEN = 'release-drift-pairing';
/** the T3 Code service, as the agent declares it */
const AGENT_SERVICE = registry.agents.t3.service.name;
/** the version the stable channel names now, which the guest records installed */
const SERVED_VERSION = '0.1.3';
/** the release the agent ran before the channel moved on */
const OLD_VERSION = '0.1.2';
/** the guest's agent at its channel's release */
const CURRENT: AgentReleaseState = {
  status: 'known',
  installed: SERVED_VERSION,
  tagged: SERVED_VERSION,
};
/** the guest's agent left on an older release than its channel names */
const DRIFTED: AgentReleaseState = {
  status: 'known',
  installed: OLD_VERSION,
  tagged: SERVED_VERSION,
};

/** a workstation that recorded T3 Code's stable channel */
const STABLE_PROFILE: WorkstationProfile = {
  ...DISABLED_NETWORK_PROFILE,
  options: { ...DISABLED_NETWORK_PROFILE.options, agentRelease: 'stable' },
};

/** what the guest's harnesses and agent report natively once the agent serves */
const NATIVE: NativeConfigurationInspection = {
  ...Object.fromEntries(
    (['claude', 'codex'] as const).map((harness) => [
      harness,
      {
        gatewayConfigured: false,
        modelDiscoveryEnabled: false,
        pluginListAvailable: false,
        awakeHooksInstalled: true,
        authentication: 'not-configured' as const,
      },
    ]),
  ),
  agentEnvironment: { ok: true, serverVersion: SERVED_VERSION },
  harnesses: {},
};

/** a ready workstation whose agent serves the installed version */
const READY: GuestInspection = {
  services: [AGENT_SERVICE, 'open-agent-cron'].map((name) => ({
    name,
    needs: [],
    status: 'running' as const,
  })),
  network: {
    online: false,
    dnsReady: false,
    skipped: true,
    reason: 'No private network is selected',
  },
  native: NATIVE,

  hub: { skipped: true, reachable: false },
  environment: environmentOf(STABLE_PROFILE, {
    tools: [
      {
        name: 't3',
        required: true,
        account: 'agent',
        executables: ['t3'],
        source: { kind: 'npm', package: 't3', account: 'agent' },
        version: SERVED_VERSION,
      },
    ],
  }),
  probeFailures: [],
  governor: { recorded: false, reason: 'no awake event has been recorded yet' },
};

/**
 * stands up a ready workstation on the stable channel whose agent service
 * runs, behind a provider client; the guest mints a pairing when asked
 * @param root directory standing for the guest filesystem
 * @returns the sprite, its client and the guest's command mock
 */
async function readyWorkstation(root: string): Promise<{
  sprite: Sprite;
  client: SpritesClient;
  execute: ReturnType<typeof vi.fn<GuestExecute>>;
}> {
  const execute = vi.fn<GuestExecute>(async (_file, args = []) => ({
    stdout: args.includes('pair')
      ? `Token: ${PAIRING_TOKEN}\nExpires: 2099-01-01T00:00:00Z\n`
      : '',
    stderr: '',
    exitCode: 0,
  }));
  const sprite = Object.assign(createFilesystemSprite({ root, execute }), {
    id: 'sprite-release',
    organizationName: 'test',
    labels: mergeMetadataLabels([MANAGED_LABEL, SCHEMA_LABEL], {
      setup: 'ready',
      profile: summarizeProfile(STABLE_PROFILE),
      version: OPEN_AGENT_VERSION,
    }),
  });
  const client = new SpritesClient('test-token');
  vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
  vi.spyOn(sprite, 'update').mockImplementation(async (options) =>
    Object.assign(sprite, options),
  );
  vi.spyOn(sprite, 'updateURLSettings').mockImplementation(
    async () => undefined,
  );
  holdServices(sprite).set(AGENT_SERVICE, {
    name: AGENT_SERVICE,
    cmd: '/bin/true',
    args: [],
    needs: [],
    state: { name: AGENT_SERVICE, status: 'running' },
  });
  await sprite
    .filesystem()
    .writeFile(ENVIRONMENT_PATH, JSON.stringify(environmentOf(STABLE_PROFILE)));

  return { sprite, client, execute };
}

/** what the guest reports in one scenario */
interface GuestReport {
  /** the agent's release against its channel */
  release: AgentReleaseState;
  /** the version the agent serves before setup restarts it */
  servedBefore?: string;
  /** the version the agent serves once the plan ran */
  servedAfter?: string;
}

/**
 * replaces the guest mechanics that need a real guest: the agent's release,
 * the plan runner and the inspections; the agent serves its earlier version
 * until the plan runs and restarts it
 * @param report the release and the versions the agent serves
 * @returns the mechanics and the plan runner's mock
 */
function mechanicsReporting(report: GuestReport): {
  guest: GuestMechanics;
  run: ReturnType<typeof vi.fn<GuestMechanics['plan']['run']>>;
} {
  const { release, servedAfter = SERVED_VERSION } = report;
  let served = report.servedBefore ?? servedAfter;
  const run = vi.fn<GuestMechanics['plan']['run']>(async () => {
    served = servedAfter;

    return { isComplete: true, steps: [] };
  });

  return {
    run,
    guest: {
      ...dependencies.guest,
      tools: { inspectAgentRelease: async () => release },
      plan: { ...dependencies.guest.plan, run },
      inspection: {
        inspect: async () => ({
          ...READY,
          native: {
            ...NATIVE,
            agentEnvironment: { ok: true, serverVersion: served },
          },
        }),
      },
      native: {
        ...dependencies.guest.native,
        inspectAgentEnvironment: async () => ({
          ok: true,
          serverVersion: served,
        }),
      },
    },
  };
}

/**
 * an interactive run that asks nothing and records each status it reports
 * @returns the interaction and the statuses it received
 */
function recordingInteraction(): {
  interaction: Interaction;
  statuses: StatusUpdate[];
} {
  const statuses: StatusUpdate[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error('setup asked a question');
  };

  return {
    statuses,
    interaction: {
      input: refuse,
      secret: refuse,
      select: refuse,
      multiselect: refuse,
      confirm: async () => true,
      progress: () => undefined,
      status: (update) => statuses.push(update),
    },
  };
}

/**
 * lists, in call order, when setup stopped, installed, exposed and paired the agent
 * @param mocks the sprite's service stop and exposure, the plan runner and the guest's commands
 * @param mocks.sprite whose stopped services and URL settings tell the stops and exposures
 * @param mocks.run whose calls tell the installs
 * @param mocks.execute whose pair commands tell the pairings
 * @returns each event once per run of consecutive calls
 */
function timelineOf(mocks: {
  sprite: Sprite;
  run: ReturnType<typeof vi.fn<GuestMechanics['plan']['run']>>;
  execute: ReturnType<typeof vi.fn<GuestExecute>>;
}): string[] {
  const { sprite, run, execute } = mocks;
  const pairings = execute.mock.invocationCallOrder.filter((_, index) =>
    execute.mock.calls[index]?.[1]?.includes('pair'),
  );

  return [
    ...vi
      .mocked(sprite.stopService)
      .mock.invocationCallOrder.map((at) => ({ at, event: 'stop' })),
    ...run.mock.invocationCallOrder.map((at) => ({ at, event: 'install' })),
    ...vi
      .mocked(sprite.updateURLSettings)
      .mock.invocationCallOrder.map((at) => ({ at, event: 'expose' })),
    ...pairings.map((at) => ({ at, event: 'pair' })),
  ]
    .sort((first, second) => first.at - second.at)
    .map(({ event }) => event)
    .filter((event, index, events) => event !== events[index - 1]);
}

/** an agent section run asking for a pairing code */
const PAIRING_REQUEST = {
  command: 'setup',
  machine: 'temporary',
  options: { section: 'agent', withPairCode: true, localCredentials: false },
} as const;

describe('fn:setupWorkstation --section agent', () => {
  it('should reinstall, then stop, restart and expose a drifted agent before pairing it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-drift-'),
    );
    const { sprite, client, execute } = await readyWorkstation(directory.path);
    const { guest, run } = mechanicsReporting({
      release: DRIFTED,
      servedBefore: OLD_VERSION,
    });
    const { interaction, statuses } = recordingInteraction();

    const result = await setupWorkstation(dependenciesWith({ guest }), {
      request: PAIRING_REQUEST,
      provider: providerOf(client),
      interaction,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { section: 'agent', pairing: { status: 'created' } },
    });
    expect(
      vi.mocked(sprite.stopService).mock.calls.map(([name]) => name),
    ).toEqual([AGENT_SERVICE]);
    expect(timelineOf({ sprite, run, execute })).toEqual([
      'install',
      'stop',
      'install',
      'expose',
      'pair',
    ]);
    expect(statuses).toContainEqual({
      kind: 'info',
      message: `T3 Code has ${OLD_VERSION} installed and serves ${OLD_VERSION}, while its stable channel names ${SERVED_VERSION}; restarting it on ${SERVED_VERSION}`,
    });
  });

  it('should restart an agent the updater moved under its running server', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-updated-'),
    );
    const { sprite, client, execute } = await readyWorkstation(directory.path);
    const { guest, run } = mechanicsReporting({
      release: CURRENT,
      servedBefore: OLD_VERSION,
    });

    const result = await setupWorkstation(dependenciesWith({ guest }), {
      request: PAIRING_REQUEST,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      ok: true,
      data: { section: 'agent', pairing: { status: 'created' } },
    });
    expect(timelineOf({ sprite, run, execute })).toEqual([
      'install',
      'stop',
      'install',
      'expose',
      'pair',
    ]);
  });

  it('should only pair an agent at its channel release', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-current-'),
    );
    const { sprite, client } = await readyWorkstation(directory.path);
    const { guest, run } = mechanicsReporting({ release: CURRENT });

    const result = await setupWorkstation(dependenciesWith({ guest }), {
      request: PAIRING_REQUEST,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      ok: true,
      data: { section: 'agent', pairing: { status: 'created' } },
    });
    expect(vi.mocked(sprite.stopService)).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('should keep the agent running and warn when its channel release cannot be read', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-unknown-'),
    );
    const { sprite, client, execute } = await readyWorkstation(directory.path);
    const { guest, run } = mechanicsReporting({
      release: { status: 'unknown', reason: 'npm error code E503' },
      servedBefore: OLD_VERSION,
    });
    const { interaction, statuses } = recordingInteraction();

    const result = await setupWorkstation(dependenciesWith({ guest }), {
      request: {
        command: 'setup',
        machine: 'temporary',
        options: { section: 'agent', localCredentials: false },
      },
      provider: providerOf(client),
      interaction,
    });

    expect(result).toMatchObject({ ok: true, data: { section: 'agent' } });
    // the plan runs over the agent still serving; only its own service
    // registration replaces the service afterwards, with no restart to expose
    expect(timelineOf({ sprite, run, execute })).toEqual(['install', 'stop']);
    expect(statuses).toContainEqual({
      kind: 'warning',
      message:
        'Could not read the stable release of T3 Code (npm error code E503); it keeps running',
    });
  });

  it('should withhold exposure when the restarted agent serves another version than the one installed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-leftover-'),
    );
    const { sprite, client } = await readyWorkstation(directory.path);
    const { guest } = mechanicsReporting({
      release: DRIFTED,
      servedAfter: '0.1.0',
    });

    const result = await setupWorkstation(dependenciesWith({ guest }), {
      request: {
        command: 'setup',
        machine: 'temporary',
        options: { section: 'agent', localCredentials: false },
      },
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        readiness: {
          failures: [`T3 Code serves 0.1.0 but ${SERVED_VERSION} is installed`],
        },
      },
    });
    expect(vi.mocked(sprite.updateURLSettings)).not.toHaveBeenCalled();
  });
});

describe('fn:isAgentReleaseChanged selection', () => {
  it('should require release work when the validated channel differs from the recorded channel', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-channel-change-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const { connection } = workstationOf(sprite);
    const selected = {
      ...STABLE_PROFILE,
      options: { ...STABLE_PROFILE.options, agentRelease: 'nightly' },
    };

    await expect(
      isAgentReleaseChanged(dependencies, {
        section: 'agent',
        connection,
        guest: await connection.guest(),
        resolved: {
          environment: environmentOf(STABLE_PROFILE),
          recorded: STABLE_PROFILE,
          profile: selected,
        },
      }),
    ).resolves.toBe(true);
  });

  it('should name the selected nightly channel when its release cannot be read', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-nightly-unknown-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const { connection } = workstationOf(sprite);
    const nightly = {
      ...STABLE_PROFILE,
      options: { ...STABLE_PROFILE.options, agentRelease: 'nightly' },
    };
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        tools: {
          ...dependencies.guest.tools,
          inspectAgentRelease: async () => ({
            status: 'unknown',
            reason: 'registry unavailable',
          }),
        },
      },
    });
    const { interaction, statuses } = recordingInteraction();

    await expect(
      isAgentReleaseChanged(wired, {
        section: 'agent',
        connection,
        guest: await connection.guest(),
        interaction,
        resolved: {
          environment: environmentOf(nightly),
          recorded: nightly,
          profile: nightly,
        },
      }),
    ).resolves.toBe(false);
    expect(statuses).toEqual([
      {
        kind: 'warning',
        message:
          'Could not read the nightly release of T3 Code (registry unavailable); it keeps running',
      },
    ]);
  });

  it('should name the default channel when no release was selected', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-default-unknown-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const { connection } = workstationOf(sprite);
    const profile = {
      ...STABLE_PROFILE,
      options: { ...STABLE_PROFILE.options, agentRelease: undefined },
    };
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        tools: {
          ...dependencies.guest.tools,
          inspectAgentRelease: async () => ({
            status: 'unknown',
            reason: 'registry unavailable',
          }),
        },
      },
    });
    const { interaction, statuses } = recordingInteraction();

    await expect(
      isAgentReleaseChanged(wired, {
        section: 'agent',
        connection,
        guest: await connection.guest(),
        interaction,
        resolved: {
          environment: environmentOf(profile),
          recorded: profile,
          profile,
        },
      }),
    ).resolves.toBe(false);
    expect(statuses).toEqual([
      {
        kind: 'warning',
        message:
          'Could not read the stable release of T3 Code (registry unavailable); it keeps running',
      },
    ]);
  });

  it.each(['agent', 'all'] as const)(
    'should keep an untracked agent running in the %s section without reporting drift',
    async (section) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-release-untracked-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const { connection } = workstationOf(sprite);
      const inspectAgentRelease = vi.fn<
        GuestMechanics['tools']['inspectAgentRelease']
      >(async () => ({ status: 'untracked' }));
      const wired = dependenciesWith({
        guest: {
          ...dependencies.guest,
          tools: { ...dependencies.guest.tools, inspectAgentRelease },
        },
      });
      const { interaction, statuses } = recordingInteraction();

      await expect(
        isAgentReleaseChanged(wired, {
          section,
          connection,
          guest: await connection.guest(),
          interaction,
          resolved: {
            environment: environmentOf(STABLE_PROFILE),
            recorded: STABLE_PROFILE,
            profile: STABLE_PROFILE,
          },
        }),
      ).resolves.toBe(false);
      expect(inspectAgentRelease).toHaveBeenCalledOnce();
      expect(statuses).toEqual([]);
    },
  );

  it.each([
    { section: 'tools', hasEnvironment: true },
    { section: 'agent', hasEnvironment: false },
  ] as const)(
    'should skip release inspection for section=$section with recorded environment=$hasEnvironment',
    async ({ section, hasEnvironment }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-release-untargeted-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const { connection } = workstationOf(sprite);
      const inspectAgentRelease = vi.fn<
        GuestMechanics['tools']['inspectAgentRelease']
      >(async () => CURRENT);
      const wired = dependenciesWith({
        guest: {
          ...dependencies.guest,
          tools: { ...dependencies.guest.tools, inspectAgentRelease },
        },
      });

      await expect(
        isAgentReleaseChanged(wired, {
          section,
          connection,
          guest: await connection.guest(),
          resolved: {
            environment: hasEnvironment
              ? environmentOf(STABLE_PROFILE)
              : undefined,
            recorded: STABLE_PROFILE,
            profile: STABLE_PROFILE,
          },
        }),
      ).resolves.toBe(false);
      expect(inspectAgentRelease).not.toHaveBeenCalled();
    },
  );

  it('should leave a current installed release running when its serving version cannot be read', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-serving-unknown-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const { connection } = workstationOf(sprite);
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        tools: {
          ...dependencies.guest.tools,
          inspectAgentRelease: async () => CURRENT,
        },
        native: {
          ...dependencies.guest.native,
          inspectAgentEnvironment: async () => undefined,
        },
      },
    });

    await expect(
      isAgentReleaseChanged(wired, {
        section: 'agent',
        connection,
        guest: await connection.guest(),
        resolved: {
          environment: environmentOf(STABLE_PROFILE),
          recorded: STABLE_PROFILE,
          profile: STABLE_PROFILE,
        },
      }),
    ).resolves.toBe(false);
  });

  it('should report drift when the channel has a release but no installed or serving version was observed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-release-uninstalled-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const { connection } = workstationOf(sprite);
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        tools: {
          ...dependencies.guest.tools,
          inspectAgentRelease: async () => ({
            status: 'known',
            tagged: SERVED_VERSION,
          }),
        },
        native: {
          ...dependencies.guest.native,
          inspectAgentEnvironment: async () => undefined,
        },
      },
    });
    const { interaction, statuses } = recordingInteraction();

    await expect(
      isAgentReleaseChanged(wired, {
        section: 'agent',
        connection,
        guest: await connection.guest(),
        interaction,
        resolved: {
          environment: environmentOf(STABLE_PROFILE),
          recorded: STABLE_PROFILE,
          profile: STABLE_PROFILE,
        },
      }),
    ).resolves.toBe(true);
    expect(statuses).toEqual([
      { kind: 'info', message: expect.stringContaining(SERVED_VERSION) },
    ]);
  });
});
