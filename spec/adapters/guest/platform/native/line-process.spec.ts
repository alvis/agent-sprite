import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { GuestLineProcess } from '#adapters/guest/platform/native/line-process';

import type {
  GuestChannel,
  GuestProcess,
} from '#application/ports/guest-channel';

vi.useFakeTimers();

class MemoryProcess extends EventEmitter implements GuestProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kill = vi.fn((): void => {
    this.emit('exit', 143);
  });

  constructor(exitOnEnd: boolean) {
    super();
    this.stdin.resume();
    this.stdin.on('finish', () => {
      if (exitOnEnd) {
        this.emit('exit', 0);
      }
    });
  }
}

/**
 * binds a line reader to an in-memory process with bounded output and time
 * @param process external process boundary
 * @returns the running conversation
 */
function openReader(process: MemoryProcess): GuestLineProcess {
  const channel = {
    spawn: vi.fn<GuestChannel['spawn']>(() => process),
  } satisfies Partial<GuestChannel>;

  return new GuestLineProcess(
    channel as Partial<GuestChannel> as GuestChannel,
    ['/bin/probe'],
    { environment: {}, limits: { timeoutMs: 40, outputChars: 64 } },
  );
}

describe('cl:GuestLineProcess', () => {
  it.each([
    {
      kind: 'stdin',
      message: /input/iu,
      fail: (process: MemoryProcess) =>
        process.stdin.emit('error', new Error('pipe closed')),
    },
    {
      kind: 'stdout',
      message: /output/iu,
      fail: (process: MemoryProcess) =>
        process.stdout.emit('error', new Error('pipe closed')),
    },
    {
      kind: 'overflow',
      message: /limit/iu,
      fail: (process: MemoryProcess) => process.stdout.write('x'.repeat(65)),
    },
    {
      kind: 'malformed',
      message: /malformed/iu,
      fail: (process: MemoryProcess) => process.stdout.write('invalid-json\n'),
    },
    {
      kind: 'timeout',
      message: /time/iu,
      fail: async () => vi.advanceTimersByTimeAsync(40),
    },
  ])(
    'should retain a terminal process failure and ignore later input ($kind)',
    async ({ fail, message }) => {
      const process = new MemoryProcess(true);
      const reader = openReader(process);
      const written: string[] = [];
      process.stdin.on('data', (chunk: Buffer) =>
        written.push(chunk.toString()),
      );

      await fail(process);
      reader.send({ ignored: true });

      await expect(reader.next()).rejects.toThrow(message);
      expect(written).toEqual([]);
      await reader.close();
    },
  );

  it('should deliver a response directly to a waiting consumer', async () => {
    const process = new MemoryProcess(true);
    const reader = openReader(process);
    const pending = reader.next();

    process.stdout.write('{"answer":42}\n');

    await expect(pending).resolves.toEqual({ answer: 42 });
    await reader.close();
  });

  it('should kill a process that does not exit after input closes', async () => {
    const process = new MemoryProcess(false);
    const reader = openReader(process);

    const closing = reader.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;

    expect(process.kill.mock.calls).toEqual([[]]);
  });
});
