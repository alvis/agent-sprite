import {
  chmod,
  mkdir,
  mkdtempDisposable,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';

import { GUEST_ROOT } from '#guest/guest-root';
import {
  checkIntervalDiagnostic,
  isUpdateDue,
  lockDirectoryCommand,
  MAX_UPDATE_CHECK_MINUTES,
  MAX_UPDATE_DUE_DAYS,
  storedDueDays,
  UPDATE_CHECK_FILE,
  UPDATE_CHECK_STAMP_FILE,
  UPDATE_ENTRY_TOOLS,
  UPDATE_GATE_SCRIPT,
  UPDATE_LOCK_DIRECTORY,
  UPDATE_LOCK_PATH,
  updateEntryCommand,
} from '#guest/update-schedule';

import { TAILSCALE_PROFILE } from '../fixtures/profile.js';

vi.useFakeTimers({
  toFake: ['Date'],
  now: new Date('2026-10-08T00:00:00.000Z'),
});

const DAY_MS = 86_400_000;

describe('fn:isUpdateDue', () => {
  it('should defer updates until the due interval and treat missing valid history as due', () => {
    const lastSuccess = '2026-10-01T00:00:00.000Z';
    const boundary = Date.parse('2026-10-08T00:00:00.000Z');

    expect([
      isUpdateDue(lastSuccess, 7, boundary - 1),
      isUpdateDue(lastSuccess, 7, boundary),
      isUpdateDue(lastSuccess, 7, boundary + 1),
      isUpdateDue('invalid', 7, boundary),
      isUpdateDue(new Date().toISOString(), 7),
    ]).toEqual([false, true, true, true, false]);
  });

  it.each([
    [1, DAY_MS - 1, false],
    [1, DAY_MS, true],
    [3, 2 * DAY_MS, false],
    [3, 4 * DAY_MS, true],
    [30, 29 * DAY_MS, false],
    [30, 30 * DAY_MS, true],
  ])(
    'should honour a due interval of %i days after %i milliseconds',
    (days, elapsed, isDue) => {
      const now = Date.parse('2026-10-08T00:00:00.000Z');

      expect(
        isUpdateDue(new Date(now - elapsed).toISOString(), days, now),
      ).toBe(isDue);
    },
  );
});

describe('fn:storedDueDays', () => {
  it('should read the due interval the stored profile records', () => {
    expect(
      storedDueDays({
        ...TAILSCALE_PROFILE,
        options: { ...TAILSCALE_PROFILE.options, updateDueIntervalDays: 3 },
      }),
    ).toEqual({ days: 3 });
  });

  it.each([
    ['a missing profile', undefined],
    ['a profile of the wrong shape', { provider: 'sprite' }],
    [
      'a profile without a whole due interval',
      {
        ...TAILSCALE_PROFILE,
        options: {
          ...TAILSCALE_PROFILE.options,
          updateDueIntervalDays: 'soon',
        },
      },
    ],
    [
      'a profile with a due interval beyond a year',
      {
        ...TAILSCALE_PROFILE,
        options: {
          ...TAILSCALE_PROFILE.options,
          updateDueIntervalDays: MAX_UPDATE_DUE_DAYS + 1,
        },
      },
    ],
    [
      'a profile with a due interval that is not a safe integer',
      {
        ...TAILSCALE_PROFILE,
        options: {
          ...TAILSCALE_PROFILE.options,
          updateDueIntervalDays: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ],
    [
      'a profile with a due interval below one',
      {
        ...TAILSCALE_PROFILE,
        options: { ...TAILSCALE_PROFILE.options, updateDueIntervalDays: 0 },
      },
    ],
  ])(
    'should fall back to seven days with a diagnostic for %s',
    (_, profile) => {
      expect(storedDueDays(profile)).toEqual({
        days: 7,
        diagnostic: expect.any(String),
      });
    },
  );

  it('should accept the longest due interval and read it from a profile that holds nothing else', () => {
    expect(
      storedDueDays({
        options: { updateDueIntervalDays: MAX_UPDATE_DUE_DAYS },
      }),
    ).toEqual({ days: MAX_UPDATE_DUE_DAYS });
  });
});

describe('fn:checkIntervalDiagnostic', () => {
  it.each(['1\n', '45\n', '45', `${String(MAX_UPDATE_CHECK_MINUTES)}\n`])(
    'should find nothing to report in an interval file holding %j',
    (contents) => {
      expect(checkIntervalDiagnostic(contents)).toBeUndefined();
    },
  );

  it.each([
    undefined,
    '',
    '\n',
    '0\n',
    '045\n',
    '1.5\n',
    '-5\n',
    'often\n',
    '45\nmore\n',
    `${String(MAX_UPDATE_CHECK_MINUTES + 1)}\n`,
  ])(
    'should explain the fallback for an interval file holding %j',
    (contents) => {
      expect(checkIntervalDiagnostic(contents)).toEqual(expect.any(String));
    },
  );
});

describe('fn:updateEntryCommand', () => {
  it('should take the lock, ask the gate, and only then replace the shell with the updater', () => {
    const steps = updateEntryCommand().split('; ');

    expect(steps).toEqual([
      `${lockDirectoryCommand()} || exit 0`,
      `exec 9>>${UPDATE_LOCK_PATH}`,
      '/usr/bin/flock -n 9 || exit 0',
      expect.stringContaining(
        `${UPDATE_GATE_SCRIPT} ${UPDATE_CHECK_FILE} ${UPDATE_CHECK_STAMP_FILE}`,
      ),
      expect.stringMatching(/^exec \S+ \S+\/updater\.js$/u),
    ]);
    expect(steps[3]).toMatch(/ \|\| exit 0$/u);
  });

  it('should nest in one single-quoted cron argument', () => {
    expect(updateEntryCommand()).not.toMatch(/['%]/u);
  });

  it('should hold the lock in a directory under the guest root and run its tools as trusted root files', () => {
    expect({
      lock: dirname(UPDATE_LOCK_PATH),
      directory: dirname(UPDATE_LOCK_DIRECTORY),
      tools: UPDATE_ENTRY_TOOLS.filter(
        (tool) => !updateEntryCommand().includes(tool),
      ),
    }).toEqual({
      lock: UPDATE_LOCK_DIRECTORY,
      directory: GUEST_ROOT,
      tools: [],
    });
  });
});

describe('fn:lockDirectoryCommand', () => {
  const uid = String(process.getuid?.() ?? 0);
  const GROUP_AND_OTHER_MODE = 0o755;
  const ROOT_ONLY_MODE = 0o700;

  /**
   * runs the command against a lock directory and reports whether it accepts it
   * @param directory the lock directory
   * @param owner account that must own it
   * @returns whether the command succeeded
   */
  async function accepts(directory: string, owner = uid): Promise<boolean> {
    const { exitCode } = await execa(
      '/bin/sh',
      ['-c', lockDirectoryCommand(directory, owner)],
      { reject: false },
    );

    return exitCode === 0;
  }

  it('should create a missing directory with mode 0700 and accept it', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const directory = join(scratch.path, 'run');

    const isAccepted = await accepts(directory);

    expect({
      isAccepted,
      mode: (await stat(directory)).mode & 0o777,
    }).toEqual({ isAccepted: true, mode: ROOT_ONLY_MODE });
  });

  it('should accept a directory that is already private and owned', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const directory = join(scratch.path, 'run');
    await mkdir(directory, { mode: ROOT_ONLY_MODE });

    await expect(accepts(directory)).resolves.toBe(true);
  });

  it('should refuse a directory another account could enter', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const directory = join(scratch.path, 'run');
    await mkdir(directory);
    await chmod(directory, GROUP_AND_OTHER_MODE);

    await expect(accepts(directory)).resolves.toBe(false);
  });

  it('should refuse a directory owned by another account', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const directory = join(scratch.path, 'run');
    await mkdir(directory, { mode: ROOT_ONLY_MODE });

    await expect(accepts(directory, String(Number(uid) + 1))).resolves.toBe(
      false,
    );
  });

  it('should refuse a link in place of the directory', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const target = join(scratch.path, 'elsewhere');
    await mkdir(target, { mode: ROOT_ONLY_MODE });
    const directory = join(scratch.path, 'run');
    await symlink(target, directory);

    await expect(accepts(directory)).resolves.toBe(false);
  });
});
