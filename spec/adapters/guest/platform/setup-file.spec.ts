import { spawn } from 'node:child_process';
import { mkdtempDisposable, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSetupFile } from '#adapters/guest/platform/setup-file';

import { createFilesystemSprite, guestOf } from '../../../mocks/sprites';

import type { GuestExecute } from '../../../mocks/sprites';

const SETUP_PREFIX = 'open-agent-setup.';

/**
 * lists the private files the setup runner leaves in the guest's /tmp
 * @returns the names of the runner's files
 */
async function setupFiles(): Promise<string[]> {
  return (await readdir('/tmp')).filter((name) =>
    name.startsWith(SETUP_PREFIX),
  );
}

/**
 * runs the guest's `/bin/sh -c` program on this computer, feeding it the input
 * @param file guest executable requested through the SDK
 * @param args guest argument array
 * @param options the call's standard input
 * @returns the program's captured outcome
 */
const runLocally: GuestExecute = async (file, args = [], options) =>
  new Promise((resolve, reject) => {
    const [program = file, ...rest] =
      file === '/usr/bin/sudo'
        ? args.slice(args.indexOf('--') + 1)
        : [file, ...args];
    const child = spawn(program, rest);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? 1,
      }),
    );
    child.stdin.end(options?.input ?? '');
  });

describe('fn:runSetupFile', () => {
  it('should fail the setup with the script status and leave no private file behind when the script exits non-zero', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-file-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: runLocally,
    });
    const before = await setupFiles();

    const failure = await runSetupFile(
      guestOf(sprite),
      Buffer.from('#!/bin/sh\nexit 7\n'),
    ).catch((error: unknown) => error);

    expect({
      failure,
      left: (await setupFiles()).filter((name) => !before.includes(name)),
    }).toEqual({
      failure: expect.objectContaining({
        code: 'PROVIDER',
        message: expect.stringContaining(
          'Guest setup file exited with status 7',
        ),
      }),
      left: [],
    });
  });

  it('should resolve and leave no private file behind when the script succeeds', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-file-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: runLocally,
    });
    const before = await setupFiles();

    await runSetupFile(guestOf(sprite), Buffer.from('#!/bin/sh\nexit 0\n'));

    expect(
      (await setupFiles()).filter((name) => !before.includes(name)),
    ).toEqual([]);
  });
});
