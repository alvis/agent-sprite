import { access, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';

import { runChild } from '#guest/run-child';

const MODULE = pathToFileURL(
  join(import.meta.dirname, '../../src/guest/run-child.ts'),
).href;
const READY_TIMEOUT_MS = 10_000;

const SHORT_TIMEOUT_MS = 300;
const TICK_MS = 20;
const CHILD_RUN_MS = 600;
const GROUP_TIMEOUT_MS = 2_000;

describe('fn:runChild', () => {
  it('should return the standard output of a child that exits cleanly', async () => {
    await expect(
      runChild(process.execPath, ['-e', 'process.stdout.write("1.2.3\\n")'], {
        env: {},
        timeoutMs: 10_000,
      }),
    ).resolves.toBe('1.2.3\n');
  });

  it('should reject with the exit status of a child that fails', async () => {
    await expect(
      runChild(process.execPath, ['-e', 'process.exit(7)'], {
        env: {},
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ status: 7 });
  });

  it('should ask a child that outlasts its time limit to stop before its limit', async () => {
    const failure: unknown = await runChild(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { env: {}, timeoutMs: SHORT_TIMEOUT_MS },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('SIGTERM');
    expect(failure).not.toHaveProperty('status');
  });

  it('should kill a child that ignores the request to stop at its limit', async () => {
    const failure: unknown = await runChild(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000)'],
      // long enough for the child to start listening before it is asked
      { env: {}, timeoutMs: GROUP_TIMEOUT_MS },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('SIGKILL');
    expect(failure).not.toHaveProperty('status');
  });

  it('should reject when the program cannot start', async () => {
    await expect(
      runChild('/nonexistent/program', [], { env: {}, timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should leave the event loop free while the child runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, TICK_MS);

    await runChild(
      process.execPath,
      ['-e', `setTimeout(() => {}, ${CHILD_RUN_MS})`],
      { env: {}, timeoutMs: 10_000 },
    ).finally(() => {
      clearInterval(timer);
    });

    // a blocking wait would let no timer fire until the child had ended
    expect(ticks).toBeGreaterThan(CHILD_RUN_MS / TICK_MS / 4);
  });

  it('should end everything a child started when the child outlasts its limit', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-run-child-'),
    );
    const ready = join(directory.path, 'ready');
    const stopped = join(directory.path, 'stopped');
    const child = [
      `const { spawn } = require('node:child_process');`,
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildOf(ready, stopped))}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join(' ');

    const failure: unknown = await runChild(process.execPath, ['-e', child], {
      env: {},
      timeoutMs: GROUP_TIMEOUT_MS,
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('SIGTERM');
    await vi.waitFor(async () => access(stopped), {
      timeout: READY_TIMEOUT_MS,
    });
  });

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'should pass %s on to everything its children started, then end by it',
    async (signal) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-run-child-'),
      );
      const ready = join(directory.path, 'ready');
      const stopped = join(directory.path, 'stopped');
      const parent = execa(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          [
            `const { runChild } = await import(${JSON.stringify(MODULE)});`,
            `await runChild(process.execPath, ['-e', ${JSON.stringify(grandchildOf(ready, stopped, signal))}], { env: {}, timeoutMs: 60000 });`,
            `process.stdout.write('continued');`,
          ].join(' '),
        ],
        { reject: false },
      );

      await vi.waitFor(async () => access(ready), {
        timeout: READY_TIMEOUT_MS,
      });
      parent.kill(signal);
      const result = await parent;

      // the process ends rather than carrying on with its next step
      expect(result.signal).toBe(signal);
      expect(result.stdout).toBe('');
      await vi.waitFor(async () => access(stopped), {
        timeout: READY_TIMEOUT_MS,
      });
    },
  );
});

/**
 * writes a program that, like brew under runuser, must hear a signal that
 * ends a process itself
 * @param ready the file it creates once running
 * @param stopped the file it creates when it hears the signal
 * @param signal the signal it listens for
 * @returns the program's source
 */
function grandchildOf(
  ready: string,
  stopped: string,
  signal: NodeJS.Signals = 'SIGTERM',
): string {
  return [
    `const { writeFileSync } = require('node:fs');`,
    `writeFileSync(${JSON.stringify(ready)}, '');`,
    `process.on(${JSON.stringify(signal)}, () => { writeFileSync(${JSON.stringify(stopped)}, ''); process.exit(0); });`,
    'setInterval(() => {}, 1000);',
  ].join(' ');
}
