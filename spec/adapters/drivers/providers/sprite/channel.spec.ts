import { ExecError, Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { SpriteGuestChannel } from '#adapters/drivers/providers/sprite/channel';

const sdk = new SpritesClient('offline-test');
const unrestricted = Object.assign(new Sprite('unrestricted', sdk), {
  getNetworkPolicy: vi.fn<Sprite['getNetworkPolicy']>(async () => ({
    rules: [],
  })),
} satisfies Partial<Sprite>);
const restricted = Object.assign(new Sprite('restricted', sdk), {
  getNetworkPolicy: vi.fn<Sprite['getNetworkPolicy']>(async () => ({
    rules: [{ action: 'deny', domain: '*' }],
  })),
} satisfies Partial<Sprite>);
const failing = Object.assign(new Sprite('failed', sdk), {
  execFile: vi.fn<Sprite['execFile']>(async () => {
    throw new ExecError('command failed', {
      exitCode: 7,
      stdout: Buffer.from('partial output'),
      stderr: Buffer.from('denied'),
    });
  }),
} satisfies Partial<Sprite>);

describe('cl:SpriteGuestChannel', () => {
  it.each([
    { sprite: unrestricted, restricted: false },
    { sprite: restricted, restricted: true },
  ])(
    'should enforce the observed network policy ($sprite.name)',
    async ({ sprite, restricted }) => {
      const channel = new SpriteGuestChannel({
        sprite,
        restorableServices: [],
      });

      const pending = channel.assertUnrestrictedNetwork();

      if (restricted) {
        await expect(pending).rejects.toThrow(/network policy/iu);
      } else {
        await expect(pending).resolves.toBeUndefined();
      }
    },
  );

  it('should return failed command output from SDK execution errors', async () => {
    const channel = new SpriteGuestChannel({
      sprite: failing,
      restorableServices: [],
    });

    await expect(
      channel.exec({ program: '/bin/false', arguments: [] }),
    ).resolves.toEqual({
      exitCode: 7,
      stdout: 'partial output',
      stderr: 'denied',
    });
  });
});
