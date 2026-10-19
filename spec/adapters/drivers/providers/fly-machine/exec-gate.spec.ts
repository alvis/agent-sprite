import { describe, expect, it } from 'vitest';

import { withExecGate } from '#adapters/drivers/providers/fly-machine/exec-gate';

const EXEC = '/apps/alpha/machines/machine-1/exec';

/**
 * a call that stays in flight until it is released
 * @param log shared record of starts, in order
 * @param name label recorded when the call starts
 * @returns the call and the function that releases it
 */
function held(
  log: string[],
  name: string,
): { call: () => Promise<string>; release: () => void } {
  const done = Promise.withResolvers<undefined>();

  return {
    async call() {
      log.push(name);
      await done.promise;

      return name;
    },
    release: () => {
      done.resolve(undefined);
    },
  };
}

describe('fn:withExecGate', () => {
  it('should keep at most three guest commands of one app in flight and start the rest in order', async () => {
    const started: string[] = [];
    const calls = ['a', 'b', 'c', 'd', 'e'].map((name) => held(started, name));

    const results = calls.map(async ({ call }) => withExecGate(EXEC, call));
    await Promise.resolve();
    const first = [...started];
    calls[0]!.release();
    await results[0];
    const second = [...started];
    calls[1]!.release();
    await results[1];
    const third = [...started];
    for (const { release } of calls) {
      release();
    }

    expect({ first, second, third, all: await Promise.all(results) }).toEqual({
      first: ['a', 'b', 'c'],
      second: ['a', 'b', 'c', 'd'],
      third: ['a', 'b', 'c', 'd', 'e'],
      all: ['a', 'b', 'c', 'd', 'e'],
    });
  });

  it('should not hold back other apps or requests that are not guest commands', async () => {
    const started: string[] = [];
    const exec = ['a', 'b', 'c'].map((name) => held(started, name));
    const results = exec.map(async ({ call }) => withExecGate(EXEC, call));
    const other = held(started, 'other-app');
    const read = held(started, 'read');

    const otherApp = withExecGate(
      '/apps/beta/machines/machine-1/exec',
      other.call,
    );
    const listing = withExecGate('/apps/alpha/machines', read.call);
    await Promise.resolve();
    const seen = [...started];
    for (const { release } of [...exec, other, read]) {
      release();
    }
    await Promise.all([...results, otherApp, listing]);

    expect(seen).toEqual(['a', 'b', 'c', 'other-app', 'read']);
  });

  it('should free its place when a command fails', async () => {
    const started: string[] = [];
    const calls = ['a', 'b', 'c'].map((name) => held(started, name));
    const results = calls.map(async ({ call }) => withExecGate(EXEC, call));
    const failing = withExecGate(EXEC, async () => {
      throw new Error('refused');
    });
    const after = held(started, 'after');
    const waiting = withExecGate(EXEC, after.call);
    calls[0]!.release();
    await results[0];
    const failure = await failing.catch((error: Error) => error.message);
    await Promise.resolve();
    const seen = [...started];
    for (const { release } of [...calls, after]) {
      release();
    }
    await Promise.all([...results, waiting]);

    expect({ failure, seen }).toEqual({
      failure: 'refused',
      seen: ['a', 'b', 'c', 'after'],
    });
  });
});
