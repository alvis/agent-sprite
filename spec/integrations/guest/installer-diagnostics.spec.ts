import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { commandError, CommandFault } from '#errors';
import {
  installerFailureMessage,
  runGuestInstaller,
} from '#integrations/guest/installer-diagnostics';
import { OperationContext, withOperation } from '#operation';
import { rememberSecret } from '#utilities/redaction';

import { createFilesystemSprite, guestOf } from '../../mocks/sprites.js';

import type { ExecResult, Sprite } from '@fly/sprites';

const options = { script: 'install-tools.js', timeoutMs: 45_000 } as const;
const installerPath = '/opt/open-agent/guest/install-tools.js';
const logPath = '/opt/open-agent/install-tools.log';

describe('fn:installerFailureMessage', () => {
  it('should select the first concrete reason after the last allowlisted command', () => {
    const log = [
      'Running /usr/bin/apt-get',
      'E: stale package error',
      'Running /usr/bin/curl',
      'curl: (22) unrelated command failed',
      'Running /usr/bin/tar',
      'notice: progress only',
      'Error: archive could not be unpacked',
      'fatal: secondary consequence',
    ].join('\n');

    expect(installerFailureMessage(options.script, log)).toBe(
      'Guest install-tools.js failed during /usr/bin/tar: Error: archive could not be unpacked',
    );
  });

  it('should attribute a failure to the Homebrew installer rather than the command before it', () => {
    const log = [
      'Running /usr/bin/install',
      'Running /bin/bash /tmp/open-agent-homebrew-x/install.sh',
      'Error: Failed to clone Homebrew',
    ].join('\n');

    expect(installerFailureMessage(options.script, log)).toBe(
      'Guest install-tools.js failed during /bin/bash /tmp/open-agent-homebrew-x/install.sh: Error: Failed to clone Homebrew',
    );
  });

  it('should name the brew step a component failed in', () => {
    const log = [
      'Running /home/linuxbrew/.linuxbrew/bin/brew update',
      'Running /home/linuxbrew/.linuxbrew/bin/brew info --json=v2 git curl',
      'Component git failed: No x86_64_linux bottle for curl; refusing to build from source',
    ].join('\n');

    expect(installerFailureMessage(options.script, log)).toBe(
      'Guest install-tools.js failed during /home/linuxbrew/.linuxbrew/bin/brew info --json=v2 git curl: Component git failed: No x86_64_linux bottle for curl; refusing to build from source',
    );
  });

  it('should leave logs without a current command and reason uninterpreted', () => {
    expect(
      installerFailureMessage(
        options.script,
        'Running /usr/bin/curl\nError: no',
      ),
    ).toBeUndefined();
    expect(
      installerFailureMessage(
        options.script,
        'Running /home/linuxbrew/.linuxbrew/bin/brew\nprogress',
      ),
    ).toBeUndefined();
    expect(
      installerFailureMessage(options.script, 'Error: stale failure'),
    ).toBeUndefined();
    expect(
      installerFailureMessage(
        options.script,
        'Running /home/linuxbrew/.linuxbrew/bin/brew\nError: old\nRunning /usr/bin/tar\nprogress',
      ),
    ).toBeUndefined();
  });

  it('should accept the byte limit and omit an overflowing log', () => {
    const ending = 'Running /home/linuxbrew/.linuxbrew/bin/brew\nError: failed';
    const withinLimit = `${'x'.repeat(131_071 - Buffer.byteLength(ending))}\n${ending}`;

    expect(installerFailureMessage(options.script, withinLimit)).toContain(
      'Error: failed',
    );
    expect(
      installerFailureMessage(options.script, `${withinLimit}x`),
    ).toBeUndefined();
    expect(
      installerFailureMessage(options.script, `${'é'.repeat(65_536)}${ending}`),
    ).toBeUndefined();
  });

  it('should redact resolved secrets before selecting and bounding a reason', () => {
    const secret = 'installer-diagnostic-private-token-67';
    rememberSecret(secret);
    const message = installerFailureMessage(
      options.script,
      `Running /usr/bin/install\nError: credential ${secret} ${'z'.repeat(700)}`,
    );

    expect(message).toContain('Error: credential [REDACTED]');
    expect(message).not.toContain(secret);
    expect(message!.length).toBeLessThanOrEqual(512);
  });
});

describe('fn:runGuestInstaller', () => {
  it('should not read the private log after a successful installer', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-installer-success-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await runGuestInstaller(guestOf(sprite), options);

    expect(execute.mock.calls).toEqual([
      [
        '/usr/bin/sudo',
        ['-n', '-E', '--', '/opt/open-agent/node/bin/node', installerPath],
        expect.objectContaining({ timeout: options.timeoutMs }),
      ],
    ]);
  });

  it('should read the private log only after installer failure and keep the original cause private', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-installer-diagnostic-'),
    );
    const secret = 'installer-sdk-private-token-83';
    rememberSecret(secret);
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) =>
      args.includes(installerPath)
        ? { stdout: '', stderr: `private stderr ${secret}`, exitCode: 17 }
        : {
            stdout: `Running /usr/bin/apt-get\nE: package failure ${secret}`,
            stderr: '',
            exitCode: 0,
          },
    );
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const failure: unknown = await runGuestInstaller(
      guestOf(sprite),
      options,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFault);
    expect(failure).toMatchObject({
      code: 'PROVIDER',
      causeVisibility: 'private',
      message:
        'Guest install-tools.js failed during /usr/bin/apt-get: E: package failure [REDACTED]',
      cause: { code: 'PROVIDER' },
    });
    expect(commandError(failure)).toEqual({
      code: 'PROVIDER',
      message:
        'Guest install-tools.js failed during /usr/bin/apt-get: E: package failure [REDACTED]',
      details: undefined,
    });
    expect(execute.mock.calls.map(([, args]) => args?.at(-1))).toEqual([
      installerPath,
      logPath,
    ]);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/usr/bin/head', '-c', '131073', logPath],
      expect.any(Object),
    );
  });

  it('should preserve the original failure when the log read fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-installer-log-failure-'),
    );
    const original = new Error('installer transport failed');
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => {
      if (args.includes(installerPath)) {
        throw original;
      }
      throw new Error('log unavailable');
    });
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(runGuestInstaller(guestOf(sprite), options)).rejects.toBe(
      original,
    );
    expect(execute.mock.calls).toHaveLength(2);
  });

  it('should preserve the original failure when the log overflows', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-installer-log-overflow-'),
    );
    const original = new Error('installer transport failed');
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => {
      if (args.includes(installerPath)) {
        throw original;
      }

      return {
        stdout: `${'x'.repeat(131_073)}Running /home/linuxbrew/.linuxbrew/bin/brew\nError: stale`,
        stderr: '',
        exitCode: 0,
      };
    });
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(runGuestInstaller(guestOf(sprite), options)).rejects.toBe(
      original,
    );
    expect(execute.mock.calls).toHaveLength(2);
  });

  it('should avoid log I/O after cancellation interrupts the installer', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-installer-cancel-'),
    );
    const pending = Promise.withResolvers<ExecResult>();
    const execute = vi.fn<Sprite['execFile']>(async () => pending.promise);
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const result = withOperation(context, async () =>
      runGuestInstaller(guestOf(sprite), options),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toMatchObject({ action: 'cancel' });
    expect(execute).toHaveBeenCalledTimes(1);
    pending.resolve({ stdout: '', stderr: '', exitCode: 0 });
  });
});
