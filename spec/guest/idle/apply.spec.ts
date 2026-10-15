import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { applyLatestDeadline } from '#guest/idle/apply';
import { handleAwakeEvent } from '#guest/idle/governor';

import {
  createIdleRoot,
  fixtureAccounts,
  fixtureCalls,
  fixtureProvider,
  setFixtureBehaviour,
  writeFixtureAdapter,
  writeSettings,
} from '../../fixtures/idle-root';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const HEARTBEAT = {
  action: 'heartbeat',
  source: 'claude',
  session: 'session-1',
} as const;

describe('fn:applyLatestDeadline', () => {
  it('should apply the deadline recomputed from every holder at the time of the apply', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider({ keepAwakeMode: 'none' }));
    await handleAwakeEvent(idle.context, HEARTBEAT);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);
    idle.setNow(T0 + 2 * MINUTE);

    const result = await applyLatestDeadline(idle.context);

    expect(result).toEqual({
      at: new Date(T0 + 2 * MINUTE).toISOString(),
      action: 'apply-deadline',
      result: new Date(T0 + 5 * MINUTE).toISOString(),
    });
    expect(await fixtureCalls(idle.root)).toEqual([
      {
        call: 'applyAwakeDeadline',
        deadline: new Date(T0 + 5 * MINUTE).toISOString(),
      },
    ]);
  });

  it('should never import a native-deadline adapter as root', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);
    vi.spyOn(process, 'getuid').mockReturnValue(0);

    const result = await applyLatestDeadline(idle.context);

    expect(result).toEqual({
      at: new Date(T0).toISOString(),
      action: 'apply-deadline',
      failure: 'a native-deadline adapter never runs as root',
    });
    expect(await fixtureAccounts(idle.root)).toEqual([]);
  });

  it('should refuse a recorded provider that does not apply deadlines', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(
      idle.root,
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(idle.root);

    const result = await applyLatestDeadline(idle.context);

    expect(result).toEqual({
      at: new Date(T0).toISOString(),
      action: 'apply-deadline',
      failure: 'the recorded provider does not apply deadlines',
    });
    expect(await fixtureAccounts(idle.root)).toEqual([]);
  });

  it('should delete the task when a hold closes while a slow API still answers the open, by applying the latest deadline after the older call', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider(), {
      idleTimeoutMinutes: 0,
      holdMaxMinutes: 60,
    });
    await writeFixtureAdapter(idle.root, undefined, 'slow-apply');
    const holder = { source: 'claude', session: 'session-1' } as const;

    const opened = handleAwakeEvent(idle.context, {
      ...holder,
      action: 'hold-open',
    });
    await sleep(100);
    // the close cannot take the apply lock within its short wait
    const closed = handleAwakeEvent(idle.context, {
      ...holder,
      action: 'hold-close',
    });
    await Promise.all([opened, closed]);

    const calls = await fixtureCalls(idle.root);
    expect(calls).toEqual([
      {
        call: 'applyAwakeDeadline',
        deadline: new Date(T0 + 60 * MINUTE).toISOString(),
      },
      // idle 0 and no hold left: a deadline that is not after now deletes
      { call: 'applyAwakeDeadline', deadline: new Date(T0).toISOString() },
    ]);
  });

  it('should not wait out a lock whose creating process no longer exists', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root);
    // a killed apply leaves a fresh lock naming a process that is gone
    await writeFile(join(idle.root, 'run/awake/.apply.lock'), '4194999 gone');
    const startedAt = performance.now();

    const result = await applyLatestDeadline(idle.context);

    expect(result).toMatchObject({
      action: 'apply-deadline',
      result: expect.any(String),
    });
    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  it('should fail within the apply budget when the adapter never answers', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root, undefined, 'hang');
    await setFixtureBehaviour(idle.root, 'hang');
    const startedAt = performance.now();

    const result = await applyLatestDeadline(idle.context);

    expect(result).toMatchObject({
      action: 'apply-deadline',
      failure: expect.stringContaining('did not finish within 1400 ms'),
    });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('should give up its lock when the caller ends the apply and record why', async () => {
    await using idle = await createIdleRoot(T0);
    await writeSettings(idle.root, fixtureProvider());
    await writeFixtureAdapter(idle.root, undefined, 'hang');
    const ended = new AbortController();
    const applying = applyLatestDeadline(idle.context, ended.signal);
    await sleep(150);
    ended.abort();

    expect(await applying).toMatchObject({
      failure: 'the apply was ended before the adapter answered',
    });
    // the lock is free again, so the next apply starts without waiting
    await setFixtureBehaviour(idle.root, 'succeed');
    const startedAt = performance.now();
    expect(await applyLatestDeadline(idle.context)).toMatchObject({
      result: expect.any(String),
    });
    expect(performance.now() - startedAt).toBeLessThan(300);
  });
});
