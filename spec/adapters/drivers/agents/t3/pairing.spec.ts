import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { pairT3 } from '#adapters/drivers/agents/t3/pairing';
import { redactResolved } from '#kernel/redaction';

import { guestOf } from '../../../../mocks/sprites';

import type {
  GuestChannel,
  GuestExecResult,
} from '#application/ports/guest-channel';

describe('fn:pairT3', () => {
  it('should reject native output without a parseable token', async () => {
    const guest = {
      exec: async (): Promise<GuestExecResult> => ({
        stdout: 'Token:  \nExpires: soon\n',
        stderr: '',
        exitCode: 0,
      }),
    } satisfies Partial<GuestChannel>;

    await expect(
      pairT3(guest as Partial<GuestChannel> as GuestChannel),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining('token') }),
    );
  });
  it('should register the generated pairing token before returning the guest result', async () => {
    const token = 'saf08-generated-native-pairing';
    const sprite = new Sprite(
      'saf08-pairing',
      new SpritesClient('sdk-unit-token'),
    );
    const execFile = vi.spyOn(sprite, 'execFile').mockResolvedValue({
      stdout: `Token: ${token}\nExpires: in five minutes\n`,
      stderr: '',
      exitCode: 0,
    });
    const pairing = await pairT3(guestOf(sprite));

    expect(pairing).toMatchObject({ token, expiresAt: 'in five minutes' });
    expect(redactResolved(`pairing failed: Token: ${token}`)).not.toContain(
      token,
    );
    expect(redactResolved(`pairing failed: Token: ${token}`)).toContain(
      'Token: [REDACTED]',
    );
    expect(execFile).toHaveBeenCalledOnce();
  });
});
