import {
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordGovernorState } from '#guest/idle/governor';
import { withAwakeHold } from '#guest/idle/hold';
import { hashSession, holderFileName } from '#guest/idle/holders';
import { readGovernorState } from '#guest/idle/state-file';
import { runChild } from '#guest/run-child';

import {
  createIdleRoot,
  fixtureProvider,
  writeSettings,
} from '../../fixtures/idle-root';
import { endProcess, writeProcess } from '../../fixtures/proc-table';

const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const HOLDER = { source: 'updater', session: 'run-1' };
const SECOND = 1_000;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * reads the governor state recorded in an awake directory
 * @param directory the awake directory
 * @param owners the account identities the state must be owned by
 * @returns the recorded state, absent when none is recorded
 */
async function recordedState(
  directory: string,
  owners: Parameters<typeof readGovernorState>[1],
): Promise<unknown> {
  const read = await readGovernorState(directory, owners);

  return read.recorded ? read.state : undefined;
}

/**
 * reads when the governor's first recorded hold expires
 * @param idle the temporary guest root a hold was opened in
 * @returns the expiry, absent when no state or hold is recorded
 */
async function firstHoldExpiry(
  idle: Awaited<ReturnType<typeof createIdleRoot>>,
): Promise<string | undefined> {
  const read = await readGovernorState(
    join(idle.root, 'run/awake'),
    idle.context.owners,
  );

  return read.recorded ? read.state.holds[0]?.expiresAt : undefined;
}

describe('fn:withAwakeHold', () => {
  it('should hold the workstation awake while the operation runs and release it after', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    const directory = join(idle.root, 'run/awake');

    const during = await withAwakeHold(
      HOLDER,
      async () => readGovernorState(directory, idle.context.owners),
      idle.context,
    );
    const after = await readGovernorState(directory, idle.context.owners);

    expect(during).toEqual({
      recorded: true,
      state: expect.objectContaining({
        openHolds: 1,
        holds: [expect.objectContaining({ source: 'updater' })],
      }),
    });
    expect(after).toEqual({
      recorded: true,
      state: expect.objectContaining({ openHolds: 0, holds: [] }),
    });
  });

  it('should release the hold and pass on the failure when the operation fails', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));

    await expect(
      withAwakeHold(
        HOLDER,
        async () => {
          throw new Error('update failed');
        },
        idle.context,
      ),
    ).rejects.toEqual(new Error('update failed'));
    expect(
      await readGovernorState(
        join(idle.root, 'run/awake'),
        idle.context.owners,
      ),
    ).toEqual({
      recorded: true,
      state: expect.objectContaining({ openHolds: 0 }),
    });
  });

  it('should run the operation when the hold cannot be recorded', async () => {
    await using idle = await createIdleRoot(T0);

    const result = await withAwakeHold(HOLDER, async () => 'updated', {
      ...idle.context,
      root: join(idle.root, 'missing'),
    });

    expect(result).toBe('updated');
  });

  it('should refuse a holder the awake command would not accept before running anything', async () => {
    await using idle = await createIdleRoot(T0);
    const ran: string[] = [];

    await expect(
      withAwakeHold(
        { source: 'Updater', session: 'run-1' },
        async () => {
          ran.push('operation');
        },
        idle.context,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining('source and session'),
      }),
    );
    expect(ran).toEqual([]);
  });

  it('should refresh the hold through an operation longer than the hold maximum', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }), {
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 1,
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const finish = Promise.withResolvers<undefined>();
    const directory = join(idle.root, 'run/awake');
    const recorded = async (): Promise<unknown> =>
      recordedState(directory, idle.context.owners);

    const held = withAwakeHold(
      HOLDER,
      async () => finish.promise,
      idle.context,
    );
    await vi.waitFor(async () => {
      expect(await recorded()).toMatchObject({ openHolds: 1 });
    });
    for (const seconds of [30, 60, 90, 120]) {
      idle.setNow(T0 + seconds * SECOND);
      vi.advanceTimersByTime(30 * SECOND);
      await vi.waitFor(async () => {
        expect(await recorded()).toMatchObject({
          holds: [
            {
              expiresAt: new Date(T0 + (seconds + 60) * SECOND).toISOString(),
            },
          ],
        });
      });
    }
    idle.setNow(T0 + 150 * SECOND);
    const during = await recordGovernorState(idle.context, []);
    finish.resolve(undefined);
    await held;
    const after = await recordGovernorState(idle.context, []);

    expect(during).toMatchObject({ openHolds: 1 });
    expect(after).toMatchObject({ openHolds: 0 });
  });

  it('should retry an open the governor could not record until the hold is recorded', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }), {
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 60,
    });
    const directory = join(idle.root, 'run/awake');
    const governorDirectories = async (): Promise<unknown> =>
      recordedState(directory, idle.context.owners);
    // the first transaction on a new workstation starts before the directories
    // the governor writes exist
    await rm(directory, { recursive: true, force: true });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const finish = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();

    const held = withAwakeHold(
      HOLDER,
      async () => {
        started.resolve(undefined);

        return finish.promise;
      },
      idle.context,
    );
    await started.promise;
    expect(await governorDirectories()).toBeUndefined();
    await mkdir(directory, { mode: 0o770 });
    vi.advanceTimersByTime(15 * SECOND);
    await vi.waitFor(async () => {
      expect(await governorDirectories()).toMatchObject({ openHolds: 1 });
    });
    finish.resolve(undefined);
    await held;
  });

  it('should refresh the hold while a real child runs, because waiting for it does not block the timer', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }), {
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 1,
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const expiries: unknown[] = [];
    const expiryOf = async (): Promise<string | undefined> =>
      firstHoldExpiry(idle);

    // a child that runs far longer than the 65 seconds the clock is moved by
    const held = withAwakeHold(
      HOLDER,
      async () =>
        runChild(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
          env: {},
          timeoutMs: 30_000,
        }),
      idle.context,
    );
    await vi.waitFor(async () => {
      expect(await expiryOf()).toBe(new Date(T0 + 60 * SECOND).toISOString());
    });
    for (const seconds of [30, 60]) {
      idle.setNow(T0 + seconds * SECOND);
      vi.advanceTimersByTime(30 * SECOND);
      await vi.waitFor(async () => {
        expect(await expiryOf()).toBe(
          new Date(T0 + (seconds + 60) * SECOND).toISOString(),
        );
      });
      expiries.push(await expiryOf());
    }
    await held;

    expect(expiries).toEqual([
      new Date(T0 + 90 * SECOND).toISOString(),
      new Date(T0 + 120 * SECOND).toISOString(),
    ]);
  });

  it('should apply the provider cap to the hold maximum and refresh at half of it', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'none', maxAwakeDeadlineMinutes: 2 }),
      { idleTimeoutMinutes: 5, holdMaxMinutes: 60 },
    );
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const finish = Promise.withResolvers<undefined>();
    const expiryOf = async (): Promise<string | undefined> =>
      firstHoldExpiry(idle);

    const held = withAwakeHold(
      HOLDER,
      async () => finish.promise,
      idle.context,
    );
    await vi.waitFor(async () => {
      expect(await expiryOf()).toBe(new Date(T0 + 120 * SECOND).toISOString());
    });
    idle.setNow(T0 + 60 * SECOND);
    vi.advanceTimersByTime(60 * SECOND);
    await vi.waitFor(async () => {
      expect(await expiryOf()).toBe(new Date(T0 + 180 * SECOND).toISOString());
    });
    finish.resolve(undefined);
    await held;
  });

  it('should keep a hold a root caller opened when the agent account removes every shared file', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    const shared = join(idle.root, 'run/awake');

    const during = await withAwakeHold(
      HOLDER,
      async () => {
        for (const entry of await readdir(shared)) {
          await rm(join(shared, entry));
        }

        return recordGovernorState(idle.context, []);
      },
      { ...idle.context, asRoot: true },
    );

    expect(during).toMatchObject({
      openHolds: 1,
      holds: [expect.objectContaining({ source: 'updater' })],
    });
    expect(await readGovernorState(shared, idle.context.owners)).toEqual({
      recorded: true,
      state: expect.objectContaining({ openHolds: 0 }),
    });
  });

  describe('managed hold of a process', () => {
    /**
     * builds a root caller whose process table is a temporary directory
     * @param idle the temporary guest root the caller works in
     * @param procRoot directory standing in for `/proc`
     * @returns the context
     */
    const asManagedRoot = (
      idle: Awaited<ReturnType<typeof createIdleRoot>>,
      procRoot: string,
    ): typeof idle.context => ({ ...idle.context, asRoot: true, procRoot });

    /**
     * reads the open holds the managed directory keeps
     * @param idle the temporary guest root the caller works in
     * @returns the file contents of every holder file
     */
    const managedHolders = async (
      idle: Awaited<ReturnType<typeof createIdleRoot>>,
    ): Promise<string[]> => {
      const directory = join(idle.root, 'run/awake-root');
      const names = (await readdir(directory)).filter((name) =>
        name.startsWith('h-'),
      );

      return Promise.all(
        names.map(async (name) => readFile(join(directory, name), 'utf8')),
      );
    };

    it('should record the holding process id and start time, and prune the hold once the process has ended', async () => {
      await using idle = await createIdleRoot(T0);
      await using proc = await mkdtempDisposable(join(tmpdir(), 'oa-proc-'));
      await writeSettings(
        idle.root,
        fixtureProvider({ keepAwakeMode: 'none' }),
      );
      await writeProcess(proc.path, { pid: process.pid, start: 4_242 });
      const context = asManagedRoot(idle, proc.path);

      const during = await withAwakeHold(
        HOLDER,
        async () => {
          const files = await managedHolders(idle);
          // the process ends while the operation is still running
          await endProcess(proc.path, process.pid);

          const state = await recordGovernorState(context, []);

          return { files, state, remaining: await managedHolders(idle) };
        },
        context,
      );

      expect(during.files).toHaveLength(1);
      expect(JSON.parse(during.files[0] ?? '')).toMatchObject({
        source: 'updater',
        pid: process.pid,
        processStart: '4242',
      });
      expect(during.state).toMatchObject({ openHolds: 0, holds: [] });
      // the ended process's holder file was removed, not just ignored
      expect(during.remaining).toEqual([]);
    });

    it('should prune the hold when the process id now belongs to a process that started at another time', async () => {
      await using idle = await createIdleRoot(T0);
      await using proc = await mkdtempDisposable(join(tmpdir(), 'oa-proc-'));
      await writeSettings(
        idle.root,
        fixtureProvider({ keepAwakeMode: 'none' }),
      );
      await writeProcess(proc.path, { pid: process.pid, start: 4_242 });
      const context = asManagedRoot(idle, proc.path);

      const during = await withAwakeHold(
        HOLDER,
        async () => {
          await writeProcess(proc.path, { pid: process.pid, start: 9_999 });

          return recordGovernorState(context, []);
        },
        context,
      );

      expect(during).toMatchObject({ openHolds: 0 });
    });

    it('should keep the hold while its process runs', async () => {
      await using idle = await createIdleRoot(T0);
      await using proc = await mkdtempDisposable(join(tmpdir(), 'oa-proc-'));
      await writeSettings(
        idle.root,
        fixtureProvider({ keepAwakeMode: 'none' }),
      );
      await writeProcess(proc.path, { pid: process.pid, start: 4_242 });
      const context = asManagedRoot(idle, proc.path);

      const during = await withAwakeHold(
        HOLDER,
        async () => recordGovernorState(context, []),
        context,
      );

      expect(during).toMatchObject({ openHolds: 1 });
    });

    it('should record no process for a hold an agent-account caller opens, which stays bound by the hold maximum alone', async () => {
      await using idle = await createIdleRoot(T0);
      await using proc = await mkdtempDisposable(join(tmpdir(), 'oa-proc-'));
      await writeSettings(
        idle.root,
        fixtureProvider({ keepAwakeMode: 'none' }),
      );
      // a process table that knows nothing: an agent hook's hold must survive it
      const context = { ...idle.context, procRoot: proc.path };

      const during = await withAwakeHold(
        HOLDER,
        async () => {
          const shared = join(idle.root, 'run/awake');
          const file = holderFileName('updater', hashSession('run-1'));

          return {
            record: JSON.parse(await readFile(join(shared, file), 'utf8')),
            state: await recordGovernorState(context, []),
          };
        },
        context,
      );

      expect(during.record).not.toHaveProperty('pid');
      expect(during.state).toMatchObject({ openHolds: 1 });
    });
  });
});
