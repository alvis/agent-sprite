import { Sprite, SpriteCommand, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  runSessionCommand,
  sessionGuest,
} from '#adapters/guest/platform/session/channel';

import { standInSession } from '../../../../mocks/session';
import { guestOf } from '../../../../mocks/sprites';

const sprite = new Sprite('session', new SpritesClient('offline-test'));
const process = new SpriteCommand(sprite, '/bin/stream', []);
Object.assign(sprite, {
  execFile: vi.fn<Sprite['execFile']>(async (_program, _args, options) => ({
    exitCode: 0,
    stdout: String(options?.env?.MODE),
    stderr: '',
  })),
  execFileHTTP: vi.fn<Sprite['execFileHTTP']>(
    async (_program, _args, options) => ({
      exitCode: 0,
      stdout: `${options?.env?.MODE}:${String(options?.input)}`,
      stderr: '',
    }),
  ),
  spawn: vi.fn<Sprite['spawn']>(() => process),
  getNetworkPolicy: vi.fn<Sprite['getNetworkPolicy']>(async () => ({
    rules: [],
  })),
} satisfies Partial<Sprite>);
const provider = guestOf(sprite);
const channel = sessionGuest(
  standInSession(provider),
  provider,
  provider.services,
);

describe('fn:sessionGuest', () => {
  it('should keep streaming and network policy checks on the provider channel', async () => {
    const spawned = channel.spawn({
      program: '/bin/stream',
      arguments: [],
      environment: { MODE: 'stream' },
    });

    vi.mocked(sprite.getNetworkPolicy).mockResolvedValueOnce({
      rules: [{ domain: '*', action: 'deny' }],
    });
    await expect(channel.assertUnrestrictedNetwork()).rejects.toThrow(
      /network policy/iu,
    );
    expect(spawned.stdout).toBe(process.stdout);
    expect(sprite.spawn).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/bin/stream'],
      { tty: false, env: { MODE: 'stream' } },
    );
  });

  it('should preserve the environment for commands with regular and session-only input', async () => {
    const regular = await channel.exec({
      program: '/bin/env',
      arguments: [],
      environment: { MODE: 'regular' },
    });
    const input = await runSessionCommand(
      channel,
      { program: '/bin/cat', arguments: [], environment: { MODE: 'input' } },
      { kind: 'text', value: 'hello' },
    );

    expect({ regular, input }).toEqual({
      regular: { exitCode: 0, stdout: 'regular', stderr: '' },
      input: { exitCode: 0, stdout: 'input:hello', stderr: '' },
    });
  });
});
