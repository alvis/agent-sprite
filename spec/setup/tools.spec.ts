import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { summarizeProfile } from '#drivers/providers/recorded';
import {
  MANAGED_LABEL,
  mergeMetadataLabels,
  SCHEMA_LABEL,
} from '#drivers/providers/sprite/labels';
import { ENVIRONMENT_PATH } from '#integrations/guest/layout';
import {
  UPDATE_GATE_ASSET,
  UPDATE_STATUS_PATH,
} from '#integrations/guest/updates';
import { setupWorkstation } from '#setup';
import {
  persistSetupProfile,
  profileUpdateSelected,
} from '#setup/integrations';
import { setupTools } from '#setup/tools';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import { environmentOf } from '../fixtures/environment.js';
import { driveInk } from '../fixtures/ink.js';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  holdServices,
  providerOf,
  workstationOf,
  writtenPaths,
} from '../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { WorkstationProfile } from '#core/profile';
import type { GuestEnvironment } from '#integrations/guest/environment/contracts';
import type { SetupContext } from '#setup/context';

import type { GuestExecute } from '../mocks/sprites.js';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#integrations/guest/session/open',
  async () => import('../mocks/session.js'),
);
// Codex trusts its hooks through its app server, a guest process only the live specs run
vi.mock('#drivers/harnesses/codex/hook-trust', () => ({
  trustCodexHooks: vi.fn(async () => undefined),
}));

/**
 * builds the disabled-network profile with a chosen due interval
 * @param days days after a success before an update is due
 * @returns the profile
 */
function withDueDays(days: number): WorkstationProfile {
  return {
    ...DISABLED_NETWORK_PROFILE,
    options: {
      ...DISABLED_NETWORK_PROFILE.options,
      updateDueIntervalDays: days,
    },
  };
}

/**
 * builds the context of a tools run
 * @param sprite sprite of the workstation
 * @param run what the run does
 * @param run.persists whether a changed interval was stored for this run
 * @returns the tools section context, non-interactive and without an update
 */
function toolsContext(
  sprite: Sprite,
  run: { persists: boolean },
): SetupContext {
  return {
    ...workstationOf(sprite),
    options: { section: 'tools' },
    input: {
      profile: DISABLED_NETWORK_PROFILE,
      runtimeEnv: {},
      sources: {},
      missing: [],
    },
    profile: DISABLED_NETWORK_PROFILE,
    persistsProfile: run.persists,
    isReleaseChanged: false,
    networkEnrolled: false,
    mutation: { started: false },
  };
}

/**
 * records the environment of a set-up workstation
 * @param sprite sprite of the workstation
 */
async function writeEnvironment(sprite: Sprite): Promise<void> {
  await sprite
    .filesystem()
    .writeFile(
      ENVIRONMENT_PATH,
      JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE)),
    );
}

/**
 * stands up a set-up workstation behind a provider client
 * @param root directory standing for the guest filesystem
 * @returns the sprite, its client and the spy on provider metadata updates
 */
async function toolsWorkstation(root: string): Promise<{
  sprite: Sprite;
  client: SpritesClient;
  metadata: ReturnType<typeof vi.spyOn>;
}> {
  const sprite = Object.assign(createFilesystemSprite({ root }), {
    id: 'sprite-tools',
    organizationName: 'test',
    labels: mergeMetadataLabels([MANAGED_LABEL, SCHEMA_LABEL], {
      setup: 'ready',
      profile: summarizeProfile(DISABLED_NETWORK_PROFILE),
      version: OPEN_AGENT_VERSION,
    }),
  });
  const client = new SpritesClient('test-token');
  vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
  const metadata = vi
    .spyOn(sprite, 'update')
    .mockImplementation(async (options) => Object.assign(sprite, options));
  await writeEnvironment(sprite);

  return { sprite, client, metadata };
}

/**
 * the tools section request the environment alone adds an interval to
 * @returns the setup request
 */
function toolsRequest(): Parameters<typeof setupWorkstation>[0] {
  return {
    command: 'setup',
    machine: 'temporary',
    options: { section: 'tools', localCredentials: false },
  };
}

/**
 * reads the due interval the guest's environment stores
 * @param root directory standing for the guest filesystem
 * @returns the stored days
 */
async function readDueDays(root: string): Promise<number> {
  const environment = JSON.parse(
    await readFile(join(root, ENVIRONMENT_PATH), 'utf8'),
  ) as GuestEnvironment;

  return environment.profile.options.updateDueIntervalDays;
}

describe('fn:setupTools --update', () => {
  it('should report how many components the update installed and how many it found current', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-counts-'),
    );
    // the gate records each tool's upgrade once the plan has run
    const execute = vi.fn<GuestExecute>(async (_file, args = []) => {
      if (args.includes(UPDATE_GATE_ASSET.installAs)) {
        await writeFile(
          join(directory.path, UPDATE_STATUS_PATH),
          JSON.stringify({
            startedAt: '2026-10-14T00:00:00Z',
            finishedAt: '2026-10-14T00:05:00Z',
            tools: [
              {
                name: 'node',
                manager: 'brew',
                required: true,
                outcome: 'skipped',
              },
              {
                name: 'git',
                manager: 'brew',
                required: true,
                outcome: 'skipped',
              },
              {
                name: 'jj',
                manager: 'brew',
                required: false,
                outcome: 'installed',
              },
              {
                name: 'claude',
                manager: 'npm',
                required: false,
                outcome: 'skipped',
              },
            ],
          }),
        );
      }

      return { stdout: 'test-version\n', stderr: '', exitCode: 0 };
    });
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    holdServices(sprite);
    const context: SetupContext = {
      ...workstationOf(sprite),
      options: { update: true },
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

    await expect(
      setupTools(await context.connection.guest(), context),
    ).resolves.toEqual({
      tools: 'updated',
      components: { installed: 1, skipped: 3, failed: 0 },
    });
  });
});

describe('fn:setupTools schedule', () => {
  it('should report the schedule as the whole outcome when a changed interval is all that was asked for', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-scheduled-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });

    await expect(
      setupTools(guestOf(sprite), toolsContext(sprite, { persists: true })),
    ).resolves.toEqual({ tools: 'scheduled' });

    expect(writtenPaths(sprite)).toEqual([]);
  });

  it('should keep its usage error when no interval changed and no update was asked for', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-usage-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });

    await expect(
      setupTools(guestOf(sprite), toolsContext(sprite, { persists: false })),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('fn:persistSetupProfile tools section', () => {
  it('should store the profile it names in one run, touching no service', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-persist-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const listServices = vi.spyOn(sprite, 'listServices');
    const createService = vi.spyOn(sprite, 'createService');
    await writeEnvironment(sprite);
    const mutation = { started: false };

    await persistSetupProfile(guestOf(sprite), withDueDays(3), {
      mutation,
      expected: DISABLED_NETWORK_PROFILE,
      section: 'tools',
    });

    expect({
      stored: await readDueDays(directory.path),
      services: [
        listServices.mock.calls.length,
        createService.mock.calls.length,
      ],
      mutated: mutation.started,
    }).toEqual({ stored: 3, services: [0, 0], mutated: true });
  });
});

describe('fn:profileUpdateSelected', () => {
  const recorded = DISABLED_NETWORK_PROFILE;

  it.each([
    ['changes the due interval', 3, true],
    ['keeps the due interval', 1, false],
  ])(
    'should report the tools section as changing the profile only when it %s',
    (_, days, isChanged) => {
      expect(profileUpdateSelected('tools', withDueDays(days), recorded)).toBe(
        isChanged,
      );
    },
  );

  it.each(['network', 'proxy', 'all'] as const)(
    'should report the %s section as changing the profile whatever the intervals',
    (section) => {
      expect(profileUpdateSelected(section, recorded, recorded)).toBe(true);
    },
  );

  it.each(['agent', 'git', 'github', 'env'] as const)(
    'should report the %s section as leaving the profile alone',
    (section) => {
      expect(profileUpdateSelected(section, recorded, recorded)).toBe(false);
    },
  );
});

describe('workflow:tools section with a due interval from the environment', () => {
  it('should keep the usage error when the environment repeats the recorded interval', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-env-same-'),
    );
    const { sprite, client } = await toolsWorkstation(directory.path);
    vi.stubEnv('OPEN_AGENT_UPDATE_DUE_DAYS', '1');

    const result = await setupWorkstation(toolsRequest(), providerOf(client));

    expect(result).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    expect(writtenPaths(sprite)).toEqual([]);
  });

  it('should store the interval once and report it when the environment changes it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-env-changed-'),
    );
    const { sprite, client, metadata } = await toolsWorkstation(directory.path);
    vi.stubEnv('OPEN_AGENT_UPDATE_DUE_DAYS', '3');

    const result = await setupWorkstation(toolsRequest(), providerOf(client));

    expect(result).toMatchObject({
      ok: true,
      data: { section: 'tools', tools: 'scheduled' },
    });
    expect(await readDueDays(directory.path)).toBe(3);
    // the metadata summary names no interval, so there is nothing to record
    expect(metadata).not.toHaveBeenCalled();
    expect(writtenPaths(sprite)).toEqual([ENVIRONMENT_PATH]);
  });

  it.each([
    ['repeats the recorded interval', '1', 1],
    ['changes the interval', '3', 3],
  ])(
    'should still open the tools menu when the environment %s',
    async (_, days, stored) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-tools-env-menu-'),
      );
      const { client } = await toolsWorkstation(directory.path);
      vi.stubEnv('OPEN_AGENT_UPDATE_DUE_DAYS', days);

      const observed = await driveInk(
        async (interaction) =>
          setupWorkstation(toolsRequest(), providerOf(client), interaction),
        [{ waitFor: 'Managed tools', input: '\r' }],
      );

      expect(observed.matchedSteps, observed.output).toBe(1);
      expect(observed.result).toMatchObject({
        ok: true,
        data: { tools: { status: 'recorded versions' } },
      });
      expect(await readDueDays(directory.path)).toBe(stored);
    },
    15_000,
  );
});
