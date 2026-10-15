import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { TAILSCALE_PROFILE } from '../fixtures/profile.js';

/** one process the updater started */
interface Spawned {
  file: string;
  args: readonly string[];
}

const { root, spawned, checked, trail, holders, behaviour } = await vi.hoisted(
  async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir: temporaryRoot } = await import('node:os');
    const { join: joinPath } = await import('node:path');

    return {
      root: await mkdtemp(joinPath(temporaryRoot(), 'open-agent-updater-')),
      spawned: [] as Array<{ file: string; args: readonly string[] }>,
      checked: [] as string[],
      trail: [] as string[],
      holders: [] as Array<{ source: string; session: string }>,
      behaviour: {
        failInstall: false,
        failProbe: false,
        outcomes: undefined as Record<string, unknown> | undefined,
      },
    };
  },
);

vi.mock('#guest/guest-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#guest/guest-root')>()),
  GUEST_ROOT: root,
  GUEST_KERNEL: `${root}/guest`,
  GUEST_NODE: `${root}/node/bin/node`,
}));

// the awake hold is the governor's own, proved with it; here it only records
// when it opens and closes around the install
vi.mock('#guest/idle/hold', () => ({
  withAwakeHold: async (
    holder: { source: string; session: string },
    operation: () => Promise<unknown>,
  ) => {
    holders.push(holder);
    trail.push(`open ${holder.source}`);
    try {
      return await operation();
    } finally {
      trail.push(`close ${holder.source}`);
    }
  },
}));

vi.mock('#guest/native-files', () => ({
  resolveTrustedFile: async (path: string) => path,
}));

vi.mock('#guest/updater/executables', () => ({
  findTrustedExecutable: async (name: string) => {
    checked.push(name);

    return `/usr/bin/${name}`;
  },
}));

vi.mock('#guest/update-versions', () => ({
  probeInstalledVersions: async () => {
    if (behaviour.failProbe) {
      throw new Error('version probe failed');
    }

    return { node: '24.1.0' };
  },
}));

vi.mock('#guest/run-child', async () => {
  const { writeFileSync } = await import('node:fs');

  return {
    runChild: async (file: string, args: readonly string[]) => {
      spawned.push({ file, args });
      if (!args[0]?.endsWith('install-tools.js')) {
        return '';
      }
      trail.push('install');
      // the installer leaves its outcomes before it can fail
      if (behaviour.outcomes) {
        writeFileSync(
          `${root}/install-outcomes.json`,
          JSON.stringify(behaviour.outcomes),
        );
      }
      if (behaviour.failInstall) {
        throw new Error('installer failed');
      }

      return '';
    },
  };
});

const manifestPath = join(root, 'manifest.json');
const outcomesPath = join(root, 'install-outcomes.json');
const intervalPath = join(root, 'update-check-minutes');
const OUTCOMES = {
  node: { status: 'skipped', version: '24.1.0' },
  jj: { status: 'installed', version: '0.30.0' },
  gh: { status: 'failed', error: 'install failed' },
};
const DAY_MS = 86_400_000;
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

/**
 * runs the updater the way cron does, which starts it on import
 * @param argv arguments after the script
 */
async function runUpdater(argv: string[]): Promise<void> {
  process.argv = ['node', 'updater.js', ...argv];
  vi.resetModules();
  await import('#guest/updater');
}

/**
 * reads the manifest the updater maintains
 * @returns the decoded manifest
 */
async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * builds the default profile with a due interval
 * @param days days after the last success before another update is due
 * @returns the stored profile
 */
function withDueDays(days: number): typeof TAILSCALE_PROFILE {
  return {
    ...TAILSCALE_PROFILE,
    options: { ...TAILSCALE_PROFILE.options, updateDueIntervalDays: days },
  };
}

/**
 * replaces the manifest the updater reads
 * @param fields what the test varies: the last success and the stored profile
 * @param fields.lastSuccessfulUpdate recorded successful-update time
 * @param fields.profile stored profile, or none
 */
async function writeManifest(fields: {
  lastSuccessfulUpdate: string;
  profile: unknown;
}): Promise<void> {
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      installedVersions: {},
      ...fields,
    }),
  );
}

/** records outcomes of an earlier run in the manifest */
async function keepEarlierOutcomes(): Promise<void> {
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...(await readManifest()),
      componentOutcomes: {
        node: { status: 'installed', version: '24.0.0' },
      },
    }),
  );
}

beforeEach(async () => {
  spawned.length = 0;
  checked.length = 0;
  trail.length = 0;
  holders.length = 0;
  behaviour.failInstall = false;
  behaviour.failProbe = false;
  behaviour.outcomes = undefined;
  await mkdir(root, { recursive: true });
  await rm(outcomesPath, { force: true });
  await writeFile(intervalPath, '30\n');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schema: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSuccessfulUpdate: '2026-01-02T00:00:00.000Z',
      installedVersions: { node: '24.0.0' },
      profile: TAILSCALE_PROFILE,
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

afterAll(() => {
  vi.resetModules();
});

describe('script:updater', () => {
  it('should install in place inside one awake hold and start no other process', async () => {
    await runUpdater(['--force']);

    expect(spawned.map(({ file, args }) => [file, ...args])).toEqual([
      [`${root}/node/bin/node`, `${root}/guest/install-tools.js`],
    ]);
    expect(trail).toEqual(['open updater', 'install', 'close updater']);
    expect(holders).toEqual([
      { source: 'updater', session: expect.stringMatching(/^[0-9a-f-]{36}$/u) },
    ]);
  });

  it('should record the installed versions and advance the success time after the install', async () => {
    const startedAt = Date.now();

    await runUpdater(['--force']);

    const manifest = await readManifest();
    const succeededAt = String(manifest.lastSuccessfulUpdate);
    expect(manifest).toMatchObject({
      installedVersions: { node: '24.1.0' },
      lastUpdateStatus: 'succeeded',
    });
    expect(new Date(succeededAt).toISOString()).toBe(succeededAt);
    expect(Date.parse(succeededAt)).toBeGreaterThanOrEqual(startedAt);
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('should record what the install did to each component in the manifest', async () => {
    behaviour.outcomes = OUTCOMES;

    await runUpdater(['--force']);

    expect(await readManifest()).toMatchObject({
      componentOutcomes: OUTCOMES,
      lastUpdateStatus: 'succeeded',
    });
  });

  it('should not read outcomes an earlier run left when this run leaves none', async () => {
    await writeFile(outcomesPath, JSON.stringify(OUTCOMES));

    await runUpdater(['--force']);

    expect(await readManifest()).not.toHaveProperty('componentOutcomes');
  });

  it('should require every program the installers run before it starts the installer', async () => {
    await runUpdater(['--force']);

    expect(checked).toEqual(
      expect.arrayContaining([
        'basename',
        'xz',
        'tar',
        'bash',
        'runuser',
        'getent',
        'groupadd',
        'useradd',
        'usermod',
        'id',
      ]),
    );
    expect(checked).not.toEqual(expect.arrayContaining(['make']));
    expect(checked).not.toEqual(expect.arrayContaining(['nproc']));
    expect(checked).not.toEqual(expect.arrayContaining(['chown']));
    expect(
      spawned.findIndex(({ args }) => args[0]?.endsWith('install-tools.js')),
    ).toBeGreaterThan(-1);
  });

  it('should clear the outcomes of an earlier run when a successful install leaves none', async () => {
    await keepEarlierOutcomes();

    await runUpdater(['--force']);

    expect(await readManifest()).toMatchObject({
      lastUpdateStatus: 'succeeded',
    });
    expect(await readManifest()).not.toHaveProperty('componentOutcomes');
  });

  it('should clear the outcomes of an earlier run when a failed install leaves none', async () => {
    await keepEarlierOutcomes();
    behaviour.failInstall = true;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await runUpdater(['--force']);

    expect(await readManifest()).toMatchObject({ lastUpdateStatus: 'failed' });
    expect(await readManifest()).not.toHaveProperty('componentOutcomes');
  });

  it('should keep the outcomes of a failed install beside the failure and the old success time', async () => {
    behaviour.failInstall = true;
    behaviour.outcomes = OUTCOMES;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await runUpdater(['--force']);

    expect(await readManifest()).toMatchObject({
      componentOutcomes: OUTCOMES,
      lastSuccessfulUpdate: '2026-01-02T00:00:00.000Z',
      lastUpdateStatus: 'failed',
    });
  });

  it('should keep the success time when the install succeeds but a version probe fails', async () => {
    behaviour.failProbe = true;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await runUpdater(['--force']);

    expect(stderr).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(await readManifest()).toMatchObject({
      installedVersions: { node: '24.0.0' },
      lastSuccessfulUpdate: '2026-01-02T00:00:00.000Z',
      lastUpdateStatus: 'failed',
    });
    // the hold closes although the probe failed after the install
    expect(trail).toEqual(['open updater', 'install', 'close updater']);
  });

  it('should keep the success time and still start no service command when the install fails', async () => {
    behaviour.failInstall = true;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await runUpdater(['--force']);

    expect(stderr).toHaveBeenCalledWith(
      `Managed updater failed: install-tools failed; see ${root}/install-tools.log.\n`,
    );
    expect(process.exitCode).toBe(1);
    expect(await readManifest()).toMatchObject({
      installedVersions: { node: '24.0.0' },
      lastSuccessfulUpdate: '2026-01-02T00:00:00.000Z',
      lastUpdateStatus: 'failed',
      lastUpdateError: `install-tools failed; see ${root}/install-tools.log`,
    });
    expect(
      spawned.map(({ file, args }: Spawned) => [file, ...args].join(' ')),
    ).toEqual([`${root}/node/bin/node ${root}/guest/install-tools.js`]);
    expect(trail).toEqual(['open updater', 'install', 'close updater']);
  });

  it('should do nothing when a scheduled run finds the update not yet due', async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSuccessfulUpdate: new Date().toISOString(),
        installedVersions: {},
        profile: TAILSCALE_PROFILE,
      }),
    );

    await runUpdater([]);

    expect(spawned).toEqual([]);
    expect(trail).toEqual([]);
  });

  it.each([
    [4, true],
    [2, false],
  ])(
    'should decide a scheduled run by the stored due interval of 3 days when the last success was %i days ago',
    async (daysAgo, isDue) => {
      await writeManifest({
        lastSuccessfulUpdate: new Date(
          Date.now() - daysAgo * DAY_MS,
        ).toISOString(),
        profile: withDueDays(3),
      });

      await runUpdater([]);

      expect(
        spawned.some(({ args }) => args[0]?.endsWith('install-tools.js')),
      ).toBe(isDue);
    },
  );

  it.each([
    ['a missing profile', undefined],
    ['a profile of the wrong shape', { provider: 'sprite' }],
    ['a due interval of zero', withDueDays(0)],
  ])(
    'should fall back to seven days with a diagnostic and still update when the manifest holds %s',
    async (_, profile) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await writeManifest({
        lastSuccessfulUpdate: new Date(Date.now() - 8 * DAY_MS).toISOString(),
        profile,
      });

      await runUpdater([]);

      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('7 days'));
      expect(
        spawned.some(({ args }) => args[0]?.endsWith('install-tools.js')),
      ).toBe(true);
    },
  );

  it('should skip a run inside the default seven days when the manifest holds no usable profile', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await writeManifest({
      lastSuccessfulUpdate: new Date(Date.now() - 6 * DAY_MS).toISOString(),
      profile: undefined,
    });

    await runUpdater([]);

    expect(spawned).toEqual([]);
  });

  it('should record why the due interval fell back even when the run finds nothing due', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await writeManifest({
      lastSuccessfulUpdate: new Date(Date.now() - DAY_MS).toISOString(),
      profile: undefined,
    });

    await runUpdater([]);

    expect(spawned).toEqual([]);
    expect(await readManifest()).toMatchObject({
      lastUpdateDiagnostic: expect.stringContaining('due interval'),
    });
  });

  it.each([
    ['is missing', undefined],
    ['is not a number', 'often\n'],
    ['is beyond a week', '10081\n'],
    ['has a leading zero', '045\n'],
  ])(
    'should record why the gate fell back when the interval file %s',
    async (_, contents) => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await rm(intervalPath, { force: true });
      if (contents !== undefined) {
        await writeFile(intervalPath, contents);
      }

      await runUpdater(['--force']);

      expect(await readManifest()).toMatchObject({
        lastUpdateDiagnostic: expect.stringContaining('interval file'),
        lastUpdateStatus: 'succeeded',
      });
    },
  );

  it('should clear an earlier diagnostic once the profile and the interval file are valid', async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...(await readManifest()),
        lastUpdateDiagnostic: 'an earlier fallback',
      }),
    );

    await runUpdater(['--force']);

    expect(await readManifest()).not.toHaveProperty('lastUpdateDiagnostic');
  });

  it('should read the due interval from its own field when the rest of the stored profile is unusable', async () => {
    await writeManifest({
      lastSuccessfulUpdate: new Date(Date.now() - 4 * DAY_MS).toISOString(),
      profile: { options: { updateDueIntervalDays: 3 } },
    });

    await runUpdater([]);

    expect(
      spawned.some(({ args }) => args[0]?.endsWith('install-tools.js')),
    ).toBe(true);
    expect(await readManifest()).not.toHaveProperty('lastUpdateDiagnostic');
  });
});
