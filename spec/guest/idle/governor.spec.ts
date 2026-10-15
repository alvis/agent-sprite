import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTER_IDLE_FORM_LIMIT_MS } from '#guest/idle/dispatch';

import {
  handleAwakeEvent,
  recordGovernorState,
  tick,
} from '#guest/idle/governor';
import { hashSession, holderFileName, writeHolder } from '#guest/idle/holders';
import { readGovernorState } from '#guest/idle/state-file';

import {
  createIdleRoot,
  fixtureAccounts,
  fixtureCalls,
  fixtureProvider,
  setFixtureBehaviour,
  writeFixtureAdapter,
  writeSettings,
} from '../../fixtures/idle-root';

import type { AwakeEvent } from '#guest/idle/command';
import type { GovernorContext } from '#guest/idle/context';
import type { AdapterResult, GovernorState } from '#guest/idle/state';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const HEARTBEAT: AwakeEvent = {
  action: 'heartbeat',
  source: 'claude',
  session: 'session-1',
};

const SHARED = 'run/awake';
const MANAGED = 'run/awake-root';
const HOLDER_NAME = holderFileName('claude', hashSession('session-1'));

afterEach(() => {
  vi.useRealTimers();
});

/**
 * turns a test context into the context of a root caller, whose own awake
 * directory is the managed one
 * @param context the test context
 * @param applyAsAgent what the agent-account child returns
 * @returns the root caller's context
 */
function asRoot(
  context: GovernorContext,
  applyAsAgent: () => Promise<AdapterResult> = context.applyAsAgent,
): GovernorContext {
  return { ...context, asRoot: true, applyAsAgent };
}

/**
 * names a time a whole number of minutes after the first event
 * @param minutes minutes after T0
 * @returns the ISO 8601 instant
 */
function at(minutes: number): string {
  return new Date(T0 + minutes * MINUTE).toISOString();
}

describe('fn:handleAwakeEvent', () => {
  it('should hand every new deadline to a native-deadline adapter', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);

    await handleAwakeEvent(idle.context, HEARTBEAT);
    idle.setNow(T0 + MINUTE);
    const opened = await handleAwakeEvent(idle.context, {
      ...HEARTBEAT,
      action: 'hold-open',
    });
    idle.setNow(T0 + 30 * MINUTE);
    const closed = await handleAwakeEvent(idle.context, {
      ...HEARTBEAT,
      action: 'hold-close',
    });

    expect(await fixtureCalls(idle.root)).toEqual([
      { call: 'applyAwakeDeadline', deadline: at(5) },
      { call: 'applyAwakeDeadline', deadline: at(61) },
      { call: 'applyAwakeDeadline', deadline: at(35) },
    ]);
    expect(opened).toMatchObject({
      keepAwakeMode: 'native-deadline',
      openHolds: 1,
      holds: [
        {
          source: 'claude',
          session: hashSession('session-1'),
          expiresAt: at(61),
        },
      ],
      deadline: at(61),
      sleepPermitted: false,
    });
    expect(closed).toEqual({
      version: 1,
      updatedAt: at(30),
      keepAwakeMode: 'native-deadline',
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 60,
      lastHeartbeat: at(30),
      holds: [],
      openHolds: 0,
      deadline: at(35),
      sleepPermitted: false,
      adapter: { at: at(30), action: 'apply-deadline', result: at(35) },
      diagnostics: [],
    });
    expect(
      await readGovernorState(
        join(idle.root, 'run/awake'),
        idle.context.owners,
      ),
    ).toEqual({
      recorded: true,
      state: closed,
    });
  });

  it('should refresh an open hold on a heartbeat and keep it until hold-close', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }), {
      idleTimeoutMinutes: 0,
      holdMaxMinutes: 10,
    });

    await handleAwakeEvent(idle.context, { ...HEARTBEAT, action: 'hold-open' });
    idle.setNow(T0 + 8 * MINUTE);
    const refreshed = await handleAwakeEvent(idle.context, HEARTBEAT);
    idle.setNow(T0 + 9 * MINUTE);
    const closed = await handleAwakeEvent(idle.context, {
      ...HEARTBEAT,
      action: 'hold-close',
    });

    expect(refreshed).toMatchObject({ openHolds: 1, deadline: at(18) });
    expect(closed).toMatchObject({ openHolds: 0, holds: [] });
    expect(closed).not.toHaveProperty('deadline');
  });

  it('should let an unrefreshed hold expire after the hold maximum', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }), {
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 10,
    });
    await handleAwakeEvent(idle.context, { ...HEARTBEAT, action: 'hold-open' });

    idle.setNow(T0 + 11 * MINUTE);
    const expired = await recordGovernorState(idle.context, []);

    expect(expired).toMatchObject({ openHolds: 0, holds: [], deadline: at(5) });
    expect(await readdir(join(idle.root, 'run/awake'))).toEqual([
      'governor.json',
    ]);
  });

  it('should record a failing adapter without failing the event', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root, undefined, 'fail');

    const state = await handleAwakeEvent(idle.context, HEARTBEAT);

    expect(state).toMatchObject({
      lastHeartbeat: at(0),
      deadline: at(5),
      adapter: {
        at: at(0),
        action: 'apply-deadline',
        failure: 'fixture deadline refused',
      },
    });
  });

  it('should record that a native-deadline provider declares no adapter as state, not as an adapter failure', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ awakeAdapter: undefined }),
    );

    const state = await handleAwakeEvent(idle.context, HEARTBEAT);

    expect(state).not.toHaveProperty('adapter');
    expect(state.diagnostics).toEqual([
      'the provider declares no awake adapter, so only state is recorded',
    ]);
  });

  it.each([
    [
      'in another provider folder',
      'drivers/providers/other/guest/fixture-awake.js',
    ],
    ['without the -awake suffix', 'drivers/providers/fixture/guest/fixture.js'],
  ])(
    'should refuse a recorded adapter %s without loading it',
    async (_, module) => {
      await using idle = await createIdleRoot(T0);
      await writeSettings(idle.root, fixtureProvider({ awakeAdapter: module }));
      await writeFixtureAdapter(idle.root, module);

      const state = await handleAwakeEvent(idle.context, HEARTBEAT);

      expect(state).not.toHaveProperty('adapter');
      expect(state.diagnostics).toEqual([
        expect.stringContaining('recorded provider is malformed'),
      ]);
      expect(await fixtureCalls(idle.root, module)).toEqual([]);
    },
  );

  it('should refuse an adapter that fails the trust check', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);

    const state = await handleAwakeEvent(
      {
        ...idle.context,
        trust: async () => {
          throw new Error('the adapter is writable by a non-root account');
        },
      },
      HEARTBEAT,
    );

    expect(state.adapter).toEqual({
      at: at(0),
      action: 'apply-deadline',
      failure: 'the adapter is writable by a non-root account',
    });
    expect(await fixtureCalls(idle.root)).toEqual([]);
  });

  it.each([
    ['governed', fixtureProvider({ keepAwakeMode: 'governed' })],
    ['none', fixtureProvider({ keepAwakeMode: 'none' })],
  ])(
    'should only record the state for a %s provider',
    async (mode, provider) => {
      await using idle = await createIdleRoot(T0);
      await writeSettings(idle.root, provider);
      await writeFixtureAdapter(idle.root);

      const state = await handleAwakeEvent(idle.context, HEARTBEAT);

      expect(state).toMatchObject({ keepAwakeMode: mode, deadline: at(5) });
      expect(state).not.toHaveProperty('adapter');
      expect(await fixtureCalls(idle.root)).toEqual([]);
    },
  );

  it('should count a failed write as idleness and release the deadline', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);
    // a directory under the holder's name makes the holder's rename fail
    await mkdir(
      join(
        idle.root,
        'run/awake',
        holderFileName('claude', hashSession('session-1')),
      ),
    );

    const state = await handleAwakeEvent(idle.context, HEARTBEAT);

    expect(state).toEqual({
      version: 1,
      updatedAt: at(0),
      keepAwakeMode: 'native-deadline',
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 60,
      holds: [],
      openHolds: 0,
      sleepPermitted: false,
      adapter: { at: at(0), action: 'apply-deadline', result: 'released' },
      diagnostics: [
        expect.stringContaining('counts as idleness'),
        // the directory in the holder's place is refused and left alone
        expect.stringContaining('invalid holder file'),
      ],
    });
    expect(await fixtureCalls(idle.root)).toEqual([
      { call: 'applyAwakeDeadline', deadline: at(0) },
    ]);
  });

  it("should hand a root caller's deadline to the agent-account child and never import the adapter itself", async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);
    const child: AdapterResult = {
      at: at(0),
      action: 'apply-deadline',
      result: at(5),
    };
    const applyAsAgent = vi.fn(async () => child);

    const state = await handleAwakeEvent(
      asRoot(idle.context, applyAsAgent),
      HEARTBEAT,
    );

    expect(state).toMatchObject({ deadline: at(5), adapter: child });
    expect(applyAsAgent).toHaveBeenCalledTimes(1);
    expect(await fixtureAccounts(idle.root)).toEqual([]);
    expect(await readdir(join(idle.root, MANAGED))).toEqual([HOLDER_NAME]);
    expect(await readdir(join(idle.root, SHARED))).toEqual(['governor.json']);
  });

  it('should keep a managed hold when the agent account removes every shared file', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    await handleAwakeEvent(asRoot(idle.context), {
      ...HEARTBEAT,
      action: 'hold-open',
    });

    for (const entry of await readdir(join(idle.root, SHARED))) {
      await rm(join(idle.root, SHARED, entry));
    }
    idle.setNow(T0 + 30 * MINUTE);
    const state = await recordGovernorState(idle.context, []);

    expect(state).toMatchObject({ openHolds: 1, deadline: at(60) });
    expect(await readdir(join(idle.root, MANAGED))).toEqual([HOLDER_NAME]);
  });

  it("should prune only the caller's own awake directory", async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    await writeFile(join(idle.root, SHARED, 'junk'), '');
    await writeFile(join(idle.root, MANAGED, 'junk'), '');

    await recordGovernorState(idle.context, []);
    const afterAgent = [
      await readdir(join(idle.root, SHARED)),
      await readdir(join(idle.root, MANAGED)),
    ];
    await recordGovernorState(asRoot(idle.context), []);

    expect(afterAgent).toEqual([['governor.json'], ['junk']]);
    expect(await readdir(join(idle.root, MANAGED))).toEqual([]);
  });

  it('should record a managed hold it could not write as idleness', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    await mkdir(join(idle.root, MANAGED, HOLDER_NAME));

    const state = await handleAwakeEvent(asRoot(idle.context), {
      ...HEARTBEAT,
      action: 'hold-open',
    });

    expect(state).toMatchObject({ openHolds: 0 });
    expect(state.diagnostics).toEqual([
      expect.stringContaining(
        'the hold-open event was not recorded, which counts as idleness',
      ),
      'ignored 1 invalid holder file(s) in the managed awake directory',
    ]);
  });

  it('should never permit sleep when a scan could not see every holder', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    for (const index of Array.from({ length: 513 }, (_, entry) => entry)) {
      await writeHolder(join(idle.root, SHARED), {
        source: 'claude',
        session: hashSession(`session-${index}`),
        lastHeartbeat: T0,
      });
    }

    const states: GovernorState[] = [];
    for (const minutes of [0, 2, 4]) {
      idle.setNow(T0 + minutes * MINUTE);
      states.push(await tick(idle.context));
    }

    expect(states[0]).toMatchObject({
      lastHeartbeat: at(0),
      deadline: at(5),
      sleepPermitted: false,
      diagnostics: [
        'the shared awake directory scan is incomplete, so sleep is not permitted: it holds more than 512 holder files',
      ],
    });
    expect(states.map(({ sleepPermitted }) => sleepPermitted)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('should find a holder among hundreds of other entries and prune them', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    for (const index of Array.from({ length: 600 }, (_, entry) => entry)) {
      await writeFile(join(idle.root, SHARED, `junk-${index}`), '');
    }

    const state = await handleAwakeEvent(idle.context, HEARTBEAT);

    expect(state).toMatchObject({
      lastHeartbeat: at(0),
      deadline: at(5),
      sleepPermitted: true,
      diagnostics: [],
    });
    expect((await readdir(join(idle.root, SHARED))).sort()).toEqual([
      'governor.json',
      HOLDER_NAME,
    ]);
  });

  it('should keep every holder when many writers report at once', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));

    await Promise.all(
      Array.from({ length: 24 }, async (_, index) =>
        handleAwakeEvent(idle.context, {
          action: 'hold-open',
          source: index % 2 ? 'claude' : 'codex',
          session: `session-${index}`,
        }),
      ),
    );
    const state = await recordGovernorState(idle.context, []);

    expect(state).toMatchObject({ openHolds: 24, deadline: at(60) });
    expect(state.holds).toHaveLength(24);
    expect(
      (await readdir(join(idle.root, 'run/awake'))).filter((name) =>
        name.startsWith('h-'),
      ),
    ).toHaveLength(24);
  });

  it('should ignore and remove an invalid holder file', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    await writeFile(
      join(idle.root, 'run/awake', `h-${'0'.repeat(64)}.json`),
      '{}',
    );

    const state = await handleAwakeEvent(idle.context, HEARTBEAT);

    expect(state.diagnostics).toEqual([
      expect.stringContaining('invalid holder file'),
    ]);
    expect(await readdir(join(idle.root, 'run/awake'))).not.toContain(
      `h-${'0'.repeat(64)}.json`,
    );
  });
});

describe('fn:recordGovernorState', () => {
  it.each([
    ['a native-deadline provider', fixtureProvider(), false],
    [
      'a governed url-traffic provider',
      fixtureProvider({ keepAwakeMode: 'governed' }),
      true,
    ],
    [
      'an opted-in cli-restore provider',
      fixtureProvider({
        keepAwakeMode: 'governed',
        wakeMode: 'cli-restore',
        supportsCliWakeSleep: true,
      }),
      true,
    ],
    [
      'a cli-restore provider without opt-in',
      fixtureProvider({ keepAwakeMode: 'governed', wakeMode: 'cli-restore' }),
      false,
    ],
    [
      'an always-on provider',
      fixtureProvider({ keepAwakeMode: 'governed', wakeMode: 'always-on' }),
      false,
    ],
    [
      'a provider never kept awake',
      fixtureProvider({ keepAwakeMode: 'none' }),
      false,
    ],
  ])(
    'should decide sleep for %s from the recorded catalog',
    async (_, provider, permitted) => {
      await using idle = await createIdleRoot(T0);
      await writeSettings(idle.root, provider, {
        idleTimeoutMinutes: 5,
        holdMaxMinutes: 60,
      });

      const state = await recordGovernorState(idle.context, []);

      expect(state).toMatchObject({
        keepAwakeMode: provider.keepAwakeMode,
        sleepPermitted: permitted,
        diagnostics: [],
      });
    },
  );

  it('should only record state, with the defaults, when no valid provider or options are recorded', async () => {
    await using idle = await createIdleRoot(T0);
    await writeFile(
      join(idle.root, 'components.json'),
      JSON.stringify({ provider: { id: 'fixture', keepAwakeMode: 'sleepy' } }),
    );

    const state = await recordGovernorState(idle.context, []);

    expect(state).toEqual({
      version: 1,
      updatedAt: at(0),
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 60,
      holds: [],
      openHolds: 0,
      sleepPermitted: false,
      diagnostics: [
        expect.stringContaining('malformed'),
        expect.stringContaining('idleTimeoutMinutes'),
        expect.stringContaining('holdMaxMinutes'),
      ],
    });
  });
});

describe('fn:tick', () => {
  it('should retry a failed idle form on the next tick and grant a full timeout after one succeeds', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root, undefined, 'fail');
    await handleAwakeEvent(idle.context, HEARTBEAT);

    const ticks: GovernorState[] = [];
    for (const minutes of [0, 2, 4, 6]) {
      idle.setNow(T0 + minutes * MINUTE);
      ticks.push(await tick(idle.context));
    }
    await setFixtureBehaviour(idle.root, 'succeed');
    for (const minutes of [7, 9]) {
      idle.setNow(T0 + minutes * MINUTE);
      ticks.push(await tick(idle.context));
    }

    expect(ticks.map(({ adapter }) => adapter)).toEqual([
      undefined,
      undefined,
      undefined,
      {
        at: at(6),
        action: 'enter-idle-form',
        failure: 'fixture suspend refused',
      },
      { at: at(7), action: 'enter-idle-form', result: 'memory-suspend' },
      { at: at(7), action: 'enter-idle-form', result: 'memory-suspend' },
    ]);
    expect(await fixtureCalls(idle.root)).toEqual([
      { call: 'enterIdleForm' },
      { call: 'enterIdleForm' },
    ]);
  });

  it('should grant a full idle timeout again after the workstation resumes', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root);
    await handleAwakeEvent(idle.context, HEARTBEAT);
    await tick(idle.context);

    // ten minutes without a tick: the workstation slept or the ticker stopped
    const due: Array<string | undefined> = [];
    for (const minutes of [10, 12, 14, 16]) {
      idle.setNow(T0 + minutes * MINUTE);
      due.push((await tick(idle.context)).adapter?.at);
    }

    expect(due).toEqual([undefined, undefined, undefined, at(16)]);
  });

  it('should keep the workstation awake while a hold is open', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root);
    await handleAwakeEvent(idle.context, { ...HEARTBEAT, action: 'hold-open' });

    for (let minutes = 0; minutes <= 58; minutes += 2) {
      idle.setNow(T0 + minutes * MINUTE);
      await tick(idle.context);
    }

    expect(await fixtureCalls(idle.root)).toEqual([]);
  });

  it('should never enter an idle form for a provider without permitted sleep', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed', wakeMode: 'always-on' }),
    );
    await writeFixtureAdapter(idle.root);
    await handleAwakeEvent(idle.context, HEARTBEAT);

    for (let minutes = 0; minutes <= 20; minutes += 2) {
      idle.setNow(T0 + minutes * MINUTE);
      await tick(idle.context);
    }

    expect(await fixtureCalls(idle.root)).toEqual([]);
  });

  it('should record an adapter that returns no idle form as a failure', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
      {
        idleTimeoutMinutes: 1,
        holdMaxMinutes: 60,
      },
    );
    await writeFixtureAdapter(idle.root, undefined, 'no-form');
    await tick(idle.context);

    idle.setNow(T0 + MINUTE);
    const state = await tick(idle.context);

    expect(state.adapter).toEqual({
      at: at(1),
      action: 'enter-idle-form',
      failure: 'the adapter returned no idle form',
    });
  });

  it('should make one idle-form call when two ticks run at once', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root, undefined, 'slow-fail');
    await handleAwakeEvent(idle.context, HEARTBEAT);
    for (const minutes of [0, 2, 4]) {
      idle.setNow(T0 + minutes * MINUTE);
      await tick(idle.context);
    }
    idle.setNow(T0 + 6 * MINUTE);

    const states = await Promise.all([tick(idle.context), tick(idle.context)]);

    expect(await fixtureCalls(idle.root)).toEqual([{ call: 'enterIdleForm' }]);
    expect(states.flatMap(({ diagnostics }) => diagnostics)).toContain(
      'an earlier idle-form call may still be running, so none is started',
    );
  });

  it('should not repeat an idle-form call that outlasted its limit while it may still run', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root, undefined, 'hang');
    await handleAwakeEvent(idle.context, HEARTBEAT);
    for (const minutes of [0, 2, 4]) {
      idle.setNow(T0 + minutes * MINUTE);
      await tick(idle.context);
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    idle.setNow(T0 + 6 * MINUTE);

    const hanging = tick(idle.context);
    await vi.waitFor(async () => {
      expect(await fixtureCalls(idle.root)).toHaveLength(1);
    });
    vi.advanceTimersByTime(ENTER_IDLE_FORM_LIMIT_MS);
    const timedOut = await hanging;
    idle.setNow(T0 + 7 * MINUTE);
    const whileInFlight = await tick(idle.context);
    idle.setNow(T0 + 8 * MINUTE + 1);
    const afterwards = tick(idle.context);
    await vi.waitFor(async () => {
      expect(await fixtureCalls(idle.root)).toHaveLength(2);
    });

    expect(timedOut.adapter).toEqual({
      at: at(6),
      action: 'enter-idle-form',
      failure: `the adapter did not finish within ${ENTER_IDLE_FORM_LIMIT_MS} ms`,
    });
    expect(whileInFlight.diagnostics).toContain(
      'an earlier idle-form call may still be running, so none is started',
    );
    vi.advanceTimersByTime(ENTER_IDLE_FORM_LIMIT_MS);
    expect((await afterwards).adapter).toMatchObject({
      action: 'enter-idle-form',
      failure: expect.stringContaining('did not finish'),
    });
  });

  it('should record why and return when a tick cannot take its lock', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root);
    await mkdir(join(idle.root, SHARED, '.lock'));

    const state = await tick(idle.context);

    expect(state.diagnostics).toEqual([
      'the awake state could not be recorded under its lock: The awake lock is not a regular file',
    ]);
    expect(await fixtureCalls(idle.root)).toEqual([]);
  });

  it('should record a call that ended without an answer as unknown, and restart the grace from the resume the boot clock saw', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root, undefined, 'unknown');
    let uptimeMs = 1_000_000;
    // the adapter is loaded between the two readings of a tick, so moving the
    // clocks there stands for a machine frozen during its idle-form call
    const context: GovernorContext = {
      ...idle.context,
      machineClock: async () => ({ bootId: 'boot-1', uptimeMs }),
      trust: async (path) => {
        idle.setNow(T0 + 30 * MINUTE);
        uptimeMs += 100;

        return path;
      },
    };
    await handleAwakeEvent(context, HEARTBEAT);

    const states: GovernorState[] = [];
    for (const minutes of [0, 2, 4, 6]) {
      idle.setNow(T0 + minutes * MINUTE);
      uptimeMs += 2 * MINUTE;
      states.push(await tick(context));
    }
    const calls: number[] = [];
    // thirty minutes in, the full timeout restarts: the next call is due at 36
    for (const minutes of [31, 33, 35, 36]) {
      idle.setNow(T0 + minutes * MINUTE);
      uptimeMs += 2 * MINUTE;
      await tick({ ...context, trust: async (path) => path });
      calls.push((await fixtureCalls(idle.root)).length);
    }

    expect({ adapter: states[3]?.adapter, calls }).toEqual({
      adapter: {
        at: at(6),
        action: 'enter-idle-form',
        result: 'unknown: fixture connection reset',
      },
      calls: [1, 1, 1, 2],
    });
  });

  it('should grant a full idle timeout after the workstation resumes from an idle form within the tick gap', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root);
    await handleAwakeEvent(idle.context, HEARTBEAT);

    const entered: string[] = [];
    for (const minutes of [0, 2, 4, 6, 8, 10, 12, 13]) {
      idle.setNow(T0 + minutes * MINUTE);
      const { adapter } = await tick(idle.context);
      if (adapter?.at === at(minutes)) {
        entered.push(adapter.at);
      }
    }

    // entered at 6; the resume at 8 starts a new grace that ends at 13
    expect(entered).toEqual([at(6), at(13)]);
  });
});
