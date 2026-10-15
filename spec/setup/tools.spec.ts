import {
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile,
} from 'node:fs/promises';
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
import { setupWorkstation } from '#setup';
import {
  persistSetupProfile,
  profileUpdateSelected,
} from '#setup/integrations';
import { setupTools } from '#setup/sections';

import { driveInk } from '../fixtures/ink.js';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  providerOf,
  workstationOf,
} from '../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { WorkstationProfile } from '#core/profile';
import type { SetupContext } from '#setup/context';

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
    initialInstallation: false,
    mutation: { started: false },
  };
}

/**
 * records the installation manifest of a set-up workstation
 * @param root directory standing for the guest filesystem
 */
async function writeManifest(root: string): Promise<void> {
  await mkdir(join(root, 'opt/open-agent'), { recursive: true });
  await writeFile(
    join(root, 'opt/open-agent/manifest.json'),
    JSON.stringify({
      schema: 1,
      createdAt: '2026-10-01',
      installedVersions: { node: '24.9.0' },
      lastSuccessfulUpdate: '2026-10-01T00:00:00Z',
      profile: DISABLED_NETWORK_PROFILE,
    }),
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
    }),
  });
  const client = new SpritesClient('test-token');
  vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
  const metadata = vi
    .spyOn(sprite, 'update')
    .mockImplementation(async (options) => Object.assign(sprite, options));
  await writeManifest(root);

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
 * reads the due interval the guest's manifest stores
 * @param root directory standing for the guest filesystem
 * @returns the stored days
 */
async function readDueDays(root: string): Promise<number> {
  const manifest = JSON.parse(
    await readFile(join(root, 'opt/open-agent/manifest.json'), 'utf8'),
  ) as { profile: WorkstationProfile };

  return manifest.profile.options.updateDueIntervalDays;
}

describe('fn:setupTools --update', () => {
  it('should report how many components the update installed and how many it found current', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tools-counts-'),
    );
    // the managed Node is already there, so the gate reports it as current
    await mkdir(join(directory.path, 'opt/open-agent/node/bin'), {
      recursive: true,
    });
    await writeFile(join(directory.path, 'opt/open-agent/node/bin/node'), '');
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: vi.fn<Sprite['execFile']>(async (_file, args = []) => {
        if (args.includes('/opt/open-agent/guest/install-tools.js')) {
          await writeFile(
            join(directory.path, 'opt/open-agent/install-outcomes.json'),
            JSON.stringify({
              node: { status: 'skipped', version: '24.1.0' },
              git: { status: 'skipped', version: '2.51.0' },
              jj: { status: 'installed', version: '0.31.0' },
              claude: { status: 'skipped', version: '2.0.1' },
            }),
          );
        }

        return { stdout: 'test-version\n', stderr: '', exitCode: 0 };
      }),
    });
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
      initialInstallation: true,
      mutation: { started: false },
    };

    await expect(setupTools(guestOf(sprite), context)).resolves.toEqual({
      tools: 'updated',
      components: { installed: 1, skipped: 3 },
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

    expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
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
    await writeManifest(directory.path);
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
    expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
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
    expect(sprite.filesystem().writeFile).toHaveBeenCalled();
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
