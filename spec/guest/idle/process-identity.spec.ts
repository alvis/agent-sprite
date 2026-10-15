import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  identifyProcess,
  isHolderProcess,
  isProcessGone,
} from '#guest/idle/process-identity';

import { endProcess, writeProcess } from '../../fixtures/proc-table';

/**
 * creates a directory standing in for the process table
 * @returns the disposable directory
 */
async function procTable(): Promise<AsyncDisposable & { path: string }> {
  return mkdtempDisposable(join(tmpdir(), 'oa-proc-'));
}

describe('fn:identifyProcess', () => {
  it('should read the start time past a command name holding spaces and parentheses', async () => {
    await using proc = await procTable();
    await writeProcess(proc.path, { pid: 321, start: 987_654 });

    expect(await identifyProcess(321, proc.path)).toEqual({
      pid: 321,
      start: '987654',
    });
  });

  it.each([
    ['a process that does not exist', undefined],
    ['a zombie', 'Z'],
  ])('should identify nothing for %s', async (_, state) => {
    await using proc = await procTable();
    if (state) {
      await writeProcess(proc.path, { pid: 321, start: 5, state });
    }

    expect(await identifyProcess(321, proc.path)).toBeUndefined();
  });

  it('should identify nothing on a system without a process table', async () => {
    expect(
      await identifyProcess(321, join(tmpdir(), 'oa-no-such-proc')),
    ).toBeUndefined();
  });
});

describe('fn:isProcessGone', () => {
  it('should find a running process with the recorded start time not gone', async () => {
    await using proc = await procTable();
    await writeProcess(proc.path, { pid: 321, start: 5 });

    expect(await isProcessGone({ pid: 321, start: '5' }, proc.path)).toBe(
      false,
    );
  });

  it.each([
    ['has exited', async (path: string) => endProcess(path, 321)],
    [
      'is a zombie',
      async (path: string) =>
        writeProcess(path, { pid: 321, start: 5, state: 'Z' }),
    ],
    [
      'was replaced by a process that started later',
      async (path: string) => writeProcess(path, { pid: 321, start: 6 }),
    ],
  ])('should find a process that %s gone', async (_, change) => {
    await using proc = await procTable();
    await writeProcess(proc.path, { pid: 321, start: 5 });
    await change(proc.path);

    expect(await isProcessGone({ pid: 321, start: '5' }, proc.path)).toBe(true);
  });

  it('should never call a process gone on a system without a process table', async () => {
    expect(
      await isProcessGone(
        { pid: 321, start: '5' },
        join(tmpdir(), 'oa-no-such-proc'),
      ),
    ).toBe(false);
  });
});

describe('fn:isHolderProcess', () => {
  it.each([
    [{ pid: 1, start: '0' }, true],
    [{ pid: 0, start: '1' }, false],
    [{ pid: 1.5, start: '1' }, false],
    [{ pid: 1, start: 'x' }, false],
    [{ pid: 1 }, false],
    ['text', false],
  ])('should judge %j as %s', (value, expected) => {
    expect(isHolderProcess(value)).toBe(expected);
  });
});
