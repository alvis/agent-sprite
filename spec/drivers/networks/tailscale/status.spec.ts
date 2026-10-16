import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { inspectTailscale } from '#drivers/networks/tailscale/status';
import { OperationContext, withOperation } from '#operation';
import { rememberSecret } from '#utilities/redaction';

import { createFilesystemSprite, guestOf } from '../../../mocks/sprites';

import type { ExecResult, Sprite } from '@fly/sprites';

describe('fn:inspectTailscale unavailable status', () => {
  it('should record nonzero and operational transport failures as bounded offline evidence', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-offline-'),
    );
    const secret = 'cor02-private-tailnet-key';
    rememberSecret(secret);
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: `unavailable ${secret} ${'x'.repeat(700)}`,
        exitCode: 7,
      })
      .mockRejectedValueOnce(new Error(`transport rejected ${secret}`));
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute,
    });

    for (const status of [
      await inspectTailscale(guestOf(sprite)),
      await inspectTailscale(guestOf(sprite)),
    ]) {
      expect(status).toMatchObject({
        online: false,
        dnsReady: false,
        skipped: false,
      });
      expect(status.reason).toBeTruthy();
      expect(status.reason!.length).toBeLessThanOrEqual(512);
      expect(status.reason).not.toContain(secret);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('should reject malformed success and programmer faults instead of marking them offline', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-invalid-'),
    );
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockResolvedValueOnce({ stdout: '{', stderr: '', exitCode: 0 })
      .mockRejectedValueOnce(new TypeError('broken SDK response'));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(inspectTailscale(guestOf(sprite))).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await expect(inspectTailscale(guestOf(sprite))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('should preserve cancellation during a deferred SDK status probe', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-cancel-'),
    );
    const pending = Promise.withResolvers<ExecResult>();
    const execute = vi
      .fn<Sprite['execFile']>()
      .mockReturnValue(pending.promise);
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const result = withOperation(context, async () =>
      inspectTailscale(guestOf(sprite)),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toMatchObject({ action: 'cancel' });
    pending.resolve({ stdout: '{}', stderr: '', exitCode: 0 });
  });
});
