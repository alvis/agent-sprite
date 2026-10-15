import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface WorkerFrame {
  type: string;
  id?: number;
  result?: unknown;
  cleanupFailed?: boolean;
}

/**
 * runs the shipped worker with the launcher's private umask and an inherited
 * local descriptor without Linux flock
 * @param lockPath temporary descriptor path for the process lifetime
 * @returns worker process, observed frames and event waiters
 */
function startWorker(lockPath: string) {
  const packedBin = process.env.OPEN_AGENT_PACKED_BIN;
  if (!packedBin) {
    throw new Error('Worker process proof requires the packed E2E runner');
  }
  const workerPath = join(
    dirname(realpathSync(packedBin)),
    '../lib/guest/guest-transaction.js',
  );
  const descriptor = openSync(lockPath, 'w');
  const worker = spawn(
    '/bin/sh',
    [
      '-c',
      'umask 077; exec "$@"',
      'open-agent-worker',
      process.execPath,
      workerPath,
      '0',
    ],
    {
      stdio: [
        'pipe',
        'pipe',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        descriptor,
      ],
    },
  );
  closeSync(descriptor);
  const closed = once(worker, 'close');
  const frames: WorkerFrame[] = [];
  const waiting: Array<{
    type: string;
    resolve: (frame: WorkerFrame) => void;
  }> = [];
  let buffer = '';
  worker.stdout!.setEncoding('utf8');
  worker.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const frame = JSON.parse(buffer.slice(0, newline)) as WorkerFrame;
      buffer = buffer.slice(newline + 1);
      frames.push(frame);
      const index = waiting.findIndex((entry) => entry.type === frame.type);
      if (index >= 0) {
        waiting.splice(index, 1)[0]!.resolve(frame);
      }
    }
  });
  const next = async (type: string): Promise<WorkerFrame> => {
    const existing = frames.find((frame) => frame.type === type);

    return existing
      ? Promise.resolve(existing)
      : new Promise((resolve) => waiting.push({ type, resolve }));
  };

  return { worker, closed, frames, next };
}

describe('actual guest transaction worker', () => {
  it('should honor a requested executable mode despite the private launch umask', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-worker-mode-'),
    );
    const executable = join(directory.path, 'managed-executable');
    const contents = '#!/bin/sh\nexit 0\n';
    const { worker, closed, frames, next } = startWorker(
      join(directory.path, 'lock'),
    );
    await next('ready');
    worker.stdin!.write(
      `${JSON.stringify({
        type: 'write',
        id: 3,
        path: executable,
        contents,
        mode: 0o755,
      })}\n`,
    );
    await next('settled');
    worker.stdin!.end();
    await next('released');
    const [exitCode] = await closed;

    expect(exitCode).toBe(0);
    expect(readFileSync(executable, 'utf8')).toBe(contents);
    expect(statSync(executable).mode & 0o777).toBe(0o755);
    expect(frames.map(({ type }) => type)).toEqual([
      'ready',
      'accepted',
      'settled',
      'released',
    ]);
  });

  it('should keep an accepted child alive through settlement before release', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-worker-child-'),
    );
    const marker = join(directory.path, 'child-finished');
    const { worker, closed, frames, next } = startWorker(
      join(directory.path, 'lock'),
    );
    await next('ready');
    worker.stdin!.write(
      `${JSON.stringify({
        type: 'run',
        id: 1,
        argv: [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], 'finished')",
          marker,
        ],
      })}\n`,
    );
    await next('accepted');
    worker.stdin!.end();
    const settled = await next('settled');
    await next('released');
    const [exitCode] = await closed;

    expect(settled).toMatchObject({
      id: 1,
      result: { stdout: '', stderr: '', exitCode: 0 },
    });
    expect(readFileSync(marker, 'utf8')).toBe('finished');
    expect(frames.map(({ type }) => type)).toEqual([
      'ready',
      'accepted',
      'settled',
      'released',
    ]);
    expect(exitCode).toBe(0);
  });

  it('should remove a transient file before acknowledging release', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-worker-cleanup-'),
    );
    const transient = join(directory.path, 'private');
    const { worker, closed, next } = startWorker(join(directory.path, 'lock'));
    await next('ready');
    worker.stdin!.write(
      `${JSON.stringify({
        type: 'write',
        id: 2,
        path: transient,
        contents: 'secret',
        mode: 0o600,
        removeOnRelease: true,
      })}\n`,
    );
    await next('settled');
    expect(existsSync(transient)).toBe(true);
    worker.stdin!.end();
    expect(await next('released')).toMatchObject({ cleanupFailed: false });
    await closed;
    expect(existsSync(transient)).toBe(false);
  });
});
