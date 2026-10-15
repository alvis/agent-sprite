import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdtempDisposable,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UPDATE_CHECK_MINUTES,
  MAX_UPDATE_CHECK_MINUTES,
} from '#guest/update-schedule';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../../src/guest/update-gate.sh', import.meta.url),
);
// the clock the stand-in `date` reports: minute 29833334 of the epoch
const NOW_SECONDS = 1_790_000_040;
const NOW_MINUTE = 29_833_334;
const FALLBACK = DEFAULT_UPDATE_CHECK_MINUTES;
const MAXIMUM = MAX_UPDATE_CHECK_MINUTES;
// the guest's /bin/sh is dash, which is stricter than the host's shell
const DASH = ['/bin/dash', '/usr/bin/dash'].find((path) => existsSync(path));

/** what one run of the gate decided and left behind */
interface Decision {
  /** whether the gate let a check through */
  isDue: boolean;
  /** the minute the gate recorded, or what was there before it ran */
  stamp: string | undefined;
  /** the gate's diagnostic */
  stderr: string;
}

/**
 * runs the gate in a sandbox whose clock stands still
 * @param shell shell that runs the gate
 * @param state what the guest holds before the run
 * @param state.schedule contents of the interval file; absent when undefined
 * @param state.stamp contents of the stamp file; absent when undefined
 * @returns the gate's decision
 */
async function decide(
  shell: string,
  state: { schedule?: string; stamp?: string },
): Promise<Decision> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-update-gate-'),
  );
  const { path } = directory;
  const schedule = join(path, 'update-check-minutes');
  const stamp = join(path, 'update-checked-minute');
  await writeFile(
    join(path, 'date'),
    `#!/bin/sh\necho ${String(NOW_SECONDS)}\n`,
  );
  await chmod(join(path, 'date'), 0o755);
  const source = await readFile(SCRIPT, 'utf8');
  await writeFile(
    join(path, 'update-gate.sh'),
    source.replace(
      'export PATH=/usr/sbin:/usr/bin:/sbin:/bin',
      `export PATH="${path}:${process.env.PATH}"`,
    ),
  );
  if (state.schedule !== undefined) {
    await writeFile(schedule, state.schedule);
  }
  if (state.stamp !== undefined) {
    await writeFile(stamp, state.stamp);
  }
  const result = await run(shell, [
    join(path, 'update-gate.sh'),
    schedule,
    stamp,
    String(FALLBACK),
    String(MAXIMUM),
  ]).then(
    ({ stderr }) => ({ isDue: true, stderr }),
    (failure: { code: number; stderr: string }) => {
      if (failure.code !== 1) {
        throw new Error(failure.stderr);
      }

      return { isDue: false, stderr: failure.stderr };
    },
  );

  return {
    ...result,
    stamp: await readFile(stamp, 'utf8').then(
      (text) => text.trim(),
      () => undefined,
    ),
  };
}

/**
 * runs the gate's cases under one shell
 * @param name how the suite names its shell, with the reason when it is skipped
 * @param shell the shell that runs the gate, or undefined when it is not installed
 */
function describeGate(name: string, shell: string | undefined): void {
  describe.skipIf(shell === undefined)(
    `script:update-gate under ${name}`,
    () => {
      const decideHere = async (state: {
        schedule?: string;
        stamp?: string;
      }): Promise<Decision> => decide(shell ?? '/bin/sh', state);

      it.each([
        [1, 0, false],
        [1, 1, true],
        [45, 44, false],
        [45, 45, true],
        [45, 46, true],
        [90, 89, false],
        [90, 90, true],
        [90, 400, true],
        [MAXIMUM, MAXIMUM - 1, false],
        [MAXIMUM, MAXIMUM, true],
      ])(
        'should honour a %i minute interval exactly when the last check was %i minutes ago',
        async (interval, elapsed, isDue) => {
          const last = String(NOW_MINUTE - elapsed);

          const decision = await decideHere({
            schedule: `${interval}\n`,
            stamp: last,
          });

          expect(decision).toEqual({
            isDue,
            stamp: isDue ? String(NOW_MINUTE) : last,
            stderr: '',
          });
        },
      );

      it('should let the first check through and record it when no check was ever recorded', async () => {
        expect(await decideHere({ schedule: '45\n' })).toEqual({
          isDue: true,
          stamp: String(NOW_MINUTE),
          stderr: '',
        });
      });

      it.each([
        ['from the future', String(NOW_MINUTE + 5)],
        ['unreadable', 'soon'],
        ['written with a leading zero', `0${String(NOW_MINUTE - 1)}`],
      ])('should treat a stamp %s as no recent check', async (_, stamp) => {
        expect(await decideHere({ schedule: '45\n', stamp })).toEqual({
          isDue: true,
          stamp: String(NOW_MINUTE),
          stderr: '',
        });
      });

      it.each([
        ['a missing file', undefined],
        ['an empty file', ''],
        ['a non-number', 'often\n'],
        ['a fraction', '1.5\n'],
        ['zero', '0\n'],
        ['a negative number', '-5\n'],
        ['a leading zero', '045\n'],
        ['more than a week', `${String(MAXIMUM + 1)}\n`],
        ['ten digits or more', '99999999999999\n'],
      ])(
        'should use the fallback interval when the interval file holds %s',
        async (_, schedule) => {
          const recent = await decideHere({
            schedule,
            stamp: String(NOW_MINUTE - FALLBACK + 1),
          });
          const elapsed = await decideHere({
            schedule,
            stamp: String(NOW_MINUTE - FALLBACK),
          });

          expect([recent.isDue, elapsed.isDue]).toEqual([false, true]);
          expect(elapsed.stderr).toContain('using 30 minutes');
        },
      );
    },
  );
}

describeGate('the host shell', '/bin/sh');
describeGate(
  DASH === undefined ? 'dash (skipped: dash is not installed)' : 'dash',
  DASH,
);
