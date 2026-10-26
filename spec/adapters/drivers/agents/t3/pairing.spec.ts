import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { pairT3 } from '#adapters/drivers/agents/t3/pairing';
import { redactResolved } from '#kernel/redaction';

import { guestOf } from '../../../../mocks/sprites';

describe('fn:pairT3', () => {
  it('should register the generated pairing token before returning the guest result', async () => {
    const token = 'saf08-generated-native-pairing';
    const sprite = new Sprite(
      'saf08-pairing',
      new SpritesClient('sdk-unit-token'),
    );
    const execFile = vi.fn<Sprite['execFile']>(async () => ({
      stdout: `Token: ${token}\nExpires: in five minutes\n`,
      stderr: '',
      exitCode: 0,
    }));
    Object.assign(sprite, { execFile } satisfies Partial<Sprite>);
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
