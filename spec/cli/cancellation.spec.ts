import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { createCommandCancellation } from '#cli/cancellation';

vi.useFakeTimers();

describe('fn:createCommandCancellation listener ownership', () => {
  it('should release both process signal listeners when the command ends', () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const cancellation = createCommandCancellation({
      onForce: vi.fn<() => void>(() => undefined),
    });

    try {
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    } finally {
      cancellation.dispose();
    }

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });
});

describe('fn:createCommandCancellation interruption', () => {
  it('should keep repeated cancellation idempotent', () => {
    const originalExitCode = process.exitCode;
    const aborted = vi.fn<() => void>(() => undefined);
    const cancellation = createCommandCancellation({
      onForce: vi.fn<() => void>(() => undefined),
    });
    cancellation.signal.addEventListener('abort', () => aborted());

    try {
      cancellation.cancel();
      expect(process.exitCode).toBe(130);

      process.exitCode = 42;
      cancellation.cancel();

      expect({
        aborted: cancellation.signal.aborted,
        abortCalls: aborted.mock.calls,
        exitCode: process.exitCode,
      }).toEqual({ aborted: true, abortCalls: [[]], exitCode: 42 });
    } finally {
      cancellation.dispose();
      process.exitCode = originalExitCode;
    }
  });

  it('should cancel on the first interrupt and force exit when final output fails on the second', () => {
    const exitCode = process.exitCode;
    const forcedExit = new Error('process exited');
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw forcedExit;
    });
    const onForce = vi.fn(() => {
      throw new Error('final output failed');
    });
    const cancellation = createCommandCancellation({ onForce });

    try {
      cancellation.interrupt();

      expect(cancellation.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(130);
      expect(onForce).not.toHaveBeenCalled();

      expect(() => cancellation.interrupt()).toThrow(forcedExit);
      expect(() => cancellation.interrupt()).not.toThrow();
      expect(onForce.mock.calls).toEqual([[]]);
      expect(exit.mock.calls).toEqual([[130]]);
    } finally {
      cancellation.dispose();
      process.exitCode = exitCode;
    }
  });

  it('should restore TTY state and exit after a successful forced flush', async () => {
    const actualProcess = process;
    const originalExitCode = actualProcess.exitCode;
    const rawModes = vi.fn<(enabled: boolean) => void>(() => undefined);
    const exits = vi.fn<(code: number) => void>(() => undefined);
    const onForce = vi.fn<() => void>(() => undefined);
    const writes: string[] = [];
    const input = new Proxy(actualProcess.stdin, {
      get(target, property, receiver) {
        if (property === 'isTTY') {
          return true;
        }
        if (property === 'setRawMode') {
          return (enabled: boolean) => {
            rawModes(enabled);

            return input;
          };
        }

        return Reflect.get(target, property, receiver);
      },
    });
    const stdout = new Proxy(actualProcess.stdout, {
      get(target, property, receiver) {
        if (property === 'write') {
          return (...args: unknown[]) => {
            const chunk = String(args[0]);
            writes.push(`stdout:${chunk}`);
            const done = args.find(
              (argument): argument is () => void =>
                typeof argument === 'function',
            );
            done?.();

            return true;
          };
        }

        return Reflect.get(target, property, receiver);
      },
    });
    const stderr = new Proxy(actualProcess.stderr, {
      get(target, property, receiver) {
        if (property === 'isTTY') {
          return true;
        }
        if (property === 'write') {
          return (...args: unknown[]) => {
            const chunk = String(args[0]);
            writes.push(`stderr:${chunk}`);
            const done = args.find(
              (argument): argument is () => void =>
                typeof argument === 'function',
            );
            done?.();

            return true;
          };
        }

        return Reflect.get(target, property, receiver);
      },
    });
    vi.stubGlobal(
      'process',
      new Proxy(actualProcess, {
        get(target, property, receiver) {
          if (property === 'stdin') {
            return input;
          }
          if (property === 'stdout') {
            return stdout;
          }
          if (property === 'stderr') {
            return stderr;
          }
          if (property === 'exit') {
            return exits;
          }
          if (property === 'on') {
            return target.on.bind(target);
          }
          if (property === 'off') {
            return target.off.bind(target);
          }

          return Reflect.get(target, property, receiver);
        },
      }),
    );
    const cancellation = createCommandCancellation({ onForce });

    try {
      cancellation.interrupt();
      cancellation.interrupt();
      await vi.advanceTimersByTimeAsync(0);

      expect({
        rawModes: rawModes.mock.calls,
        writes,
        onForce: onForce.mock.calls,
        exits: exits.mock.calls,
        exitCode: actualProcess.exitCode,
      }).toEqual({
        rawModes: [[false]],
        writes: ['stderr:\u001b[?25h', 'stdout:', 'stderr:'],
        onForce: [[]],
        exits: [[130]],
        exitCode: 130,
      });
    } finally {
      cancellation.dispose();
      actualProcess.exitCode = originalExitCode;
    }
  });
});
