import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { runGuest, runGuestResult } from '#adapters/guest/platform/run';
import { OperationContext, withOperation } from '#kernel/operation';
import { rememberSecret } from '#kernel/redaction';

import { guestOf } from '../../../mocks/sprites';

describe('fn:runGuest', () => {
  it('should report only the sanitized final stderr tail and semantic step on nonzero exit', async () => {
    const secret = 'saf06-test-secret-unique';
    rememberSecret(secret);
    const sprite = new Sprite(
      'diagnostics',
      new SpritesClient('sdk-only-token'),
    );
    const argvSecret = 'argv-private-unique';
    const envSecret = 'env-private-unique';
    const inputSecret = 'input-private-unique';
    const stderr = `old-diagnostic-${'x'.repeat(520)}\u001b[31m${secret}\u001b[0m\u0000final-marker`;
    const execute = vi.spyOn(sprite, 'execFileHTTP').mockResolvedValue({
      stdout: 'stdout-private-unique',
      stderr,
      exitCode: 23,
    });

    const failure = await runGuest(
      guestOf(sprite),
      ['/opt/private-executable', argvSecret],
      {
        step: 'updater verification',
        env: { PRIVATE: envSecret },
        input: inputSecret,
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'PROVIDER' });
    const message = String((failure as Error).message);
    expect(message).toContain(
      'Guest updater verification exited with status 23',
    );
    expect(message).toContain('[REDACTED]');
    expect(message).toContain('final-marker');
    expect(message).not.toContain('old-diagnostic');
    for (const privateValue of [
      secret,
      argvSecret,
      envSecret,
      inputSecret,
      'stdout-private-unique',
      '/opt/private-executable',
    ]) {
      expect(message).not.toContain(privateValue);
    }
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u0000');
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('fn:runGuestResult cancellation', () => {
  it('should forward the originating signal and existing timeout to SDK exec and HTTP boundaries', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-exec-token'),
    );
    const exec = vi.spyOn(sprite, 'execFile').mockResolvedValue({
      stdout: 'regular',
      stderr: '',
      exitCode: 0,
    });
    const http = vi.spyOn(sprite, 'execFileHTTP').mockResolvedValue({
      stdout: 'http',
      stderr: '',
      exitCode: 0,
    });
    const context = new OperationContext({
      signal: new AbortController().signal,
    });

    const result = await withOperation(context, async () => {
      const regular = await runGuestResult(guestOf(sprite), ['/bin/true'], {
        timeoutMs: 45_000,
      });
      const uploaded = await runGuestResult(guestOf(sprite), ['/bin/cat'], {
        input: 'sample',
      });

      return { regular, uploaded };
    });

    expect(result.regular.stdout).toBe('regular');
    expect(result.uploaded.stdout).toBe('http');
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/bin/true'],
      expect.objectContaining({ signal: context.signal, timeout: 45_000 }),
    );
    expect(http).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/bin/cat'],
      expect.objectContaining({
        signal: context.signal,
        input: 'sample',
        timeout: 120_000,
      }),
    );
  });

  it('should start no SDK exec after the invocation is cancelled', async () => {
    const sprite = new Sprite(
      'disposable',
      new SpritesClient('sdk-only-abort-token'),
    );
    const exec = vi.spyOn(sprite, 'execFile');
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });

    await expect(
      withOperation(context, async () => {
        controller.abort();

        return runGuestResult(guestOf(sprite), ['/bin/true']);
      }),
    ).rejects.toMatchObject({ action: 'cancel' });

    expect(exec).not.toHaveBeenCalled();
  });
});
