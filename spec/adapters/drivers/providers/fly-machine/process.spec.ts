import { spawn } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { flyctlAgent } from '#adapters/drivers/providers/fly-machine/agent';
import {
  FlyGuestProcess,
  KILLED_STATUS,
} from '#adapters/drivers/providers/fly-machine/process';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

vi.mock('node:child_process', async (importOriginal) => {
  const module = {
    ...(await importOriginal<typeof import('node:child_process')>()),
  };
  const { PassThrough } = await import('node:stream');

  const start = vi.fn<
    (...args: Parameters<typeof spawn>) => ReturnType<typeof spawn>
  >(
    () =>
      Object.assign(new module.ChildProcess(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      }) satisfies Pick<
        ChildProcessByStdio<Writable, Readable, Readable>,
        'stdin' | 'stdout' | 'stderr' | 'kill'
      >,
  );

  return {
    spawn: start as typeof start & typeof module.spawn,
  } satisfies Partial<typeof import('node:child_process')>;
});
vi.mock(
  '#adapters/drivers/providers/fly-machine/agent',
  () =>
    ({
      flyctlAgent: {
        hold: vi.fn(async <T>(session: () => Promise<T>): Promise<T> =>
          session(),
        ) as typeof flyctlAgent.hold,
      } satisfies Partial<typeof flyctlAgent> as Partial<
        typeof flyctlAgent
      > as typeof flyctlAgent,
    }) satisfies Partial<
      typeof import('#adapters/drivers/providers/fly-machine/agent')
    >,
);

const session = {
  program: 'fly',
  arguments: ['ssh', 'console'],
  marker: '@@status:',
  token: async () => 'test-token',
};

describe('cl:FlyGuestProcess', () => {
  it('should finish once when killed while agent registration is pending', async () => {
    const waiting = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<void>();
    vi.mocked(flyctlAgent.hold).mockImplementationOnce(
      async <T>(run: () => Promise<T>): Promise<T> => {
        waiting.resolve();
        await acquired.promise;

        return run();
      },
    );
    const guest = new FlyGuestProcess(session);
    const exited = vi.fn();
    const failed = vi.fn();
    guest.on('exit', exited).on('error', failed);
    await waiting.promise;

    guest.kill();
    await nextTurn();
    acquired.resolve();
    await nextTurn();

    expect(exited).toHaveBeenCalledExactlyOnceWith(KILLED_STATUS);
    expect(failed).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('should report an operating-system spawn failure as a provider failure', async () => {
    const guest = new FlyGuestProcess(session);
    const failed = Promise.withResolvers<unknown>();
    guest.on('error', failed.resolve);
    await nextTurn();
    const child = vi.mocked(spawn).mock.results[0]!
      .value as ChildProcessByStdio<Writable, Readable, Readable>;
    const failure = Object.assign(new Error('no executable'), {
      code: 'ENOENT',
    });

    child.emit('error', failure);

    await expect(failed.promise).resolves.toMatchObject({
      code: 'failed',
      message: expect.stringContaining('no executable'),
      cause: failure,
    });
  });

  it('should retain the reported status after input fails and the consumer closes its output', async () => {
    const guest = new FlyGuestProcess(session);
    const exited = Promise.withResolvers<number>();
    const failed = vi.fn();
    guest.on('exit', exited.resolve).on('error', failed);
    await nextTurn();
    const child = vi.mocked(spawn).mock.results[0]!
      .value as ChildProcessByStdio<Writable, Readable, Readable>;
    guest.stdout.destroy();
    guest.stderr.destroy();

    child.stdin.emit(
      'error',
      Object.assign(new Error('pipe closed'), { code: 'EPIPE' }),
    );
    child.stderr.emit('data', Buffer.from('late diagnostic\n@@status:0\n'));
    child.stderr.emit('end');
    child.emit('close', 0);

    await expect(exited.promise).resolves.toBe(0);
    expect(failed).not.toHaveBeenCalled();
    guest.kill();
  });
});
