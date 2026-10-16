import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ensurePrivateDirectory,
  removeOwnedFile,
  runAsAgent,
  writeOwnedFile,
} from '#integrations/guest/account';

import {
  createFilesystemSprite,
  executeNativeConfiguration,
  guestOf,
} from '../../mocks/sprites';

describe('fn:runAsAgent', () => {
  it('should start native commands in the runtime home instead of the provider shell directory', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-native-home-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async (_file, args = []) => ({
        stdout: args.includes('--chdir=/home/agent')
          ? '/home/agent\n'
          : '/home/sprite\n',
        stderr: '',
        exitCode: 0,
      }),
    });

    const result = await runAsAgent(guestOf(sprite), ['/bin/pwd']);

    expect(result.stdout.trim()).toBe('/home/agent');
  });
});

describe('native account SDK boundary', () => {
  it('should resolve numeric account IDs from the command tail after extra sudo options', async () => {
    for (const [flag, expected] of [
      ['-u', '1001\n'],
      ['-g', '1001\n'],
    ]) {
      const result = await executeNativeConfiguration('/usr/bin/sudo', [
        '-n',
        '-E',
        '--preserve-env=HOME',
        '--',
        '/usr/bin/id',
        flag!,
        'sprite',
      ]);

      expect(result).toEqual({ stdout: expected, stderr: '', exitCode: 0 });
    }
  });

  it('should dispatch both accounts through runuser and sends private writes over HTTP stdin', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-native-dispatch-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await ensurePrivateDirectory(guestOf(sprite), '/home/agent/.config');
    await ensurePrivateDirectory(guestOf(sprite), '/home/sprite/.config', {
      user: 'sprite',
      shellAccounts: ['sprite'],
    });
    await writeOwnedFile(
      guestOf(sprite),
      '/home/agent/.config/native.json',
      'private',
    );
    await removeOwnedFile(guestOf(sprite), '/home/agent/.config/native.json');

    // each runs the home files program inline as its account, `$0` then its operation
    const { mock: plain } = vi.mocked(sprite.execFile);
    const { mock: http } = vi.mocked(sprite.execFileHTTP);
    const programs = [
      ...plain.calls.map(([, args], index) => ({
        args: args ?? [],
        order: plain.invocationCallOrder[index] ?? 0,
      })),
      ...http.calls.map(([, args], index) => ({
        args: args ?? [],
        order: http.invocationCallOrder[index] ?? 0,
      })),
    ]
      .sort((left, right) => left.order - right.order)
      .map(({ args }) => args)
      .filter((args) => args.includes('oa-home-files'));
    expect(
      programs.map((args) => [
        ...args.slice(3, 9),
        ...args.slice(args.indexOf('oa-home-files') + 1),
      ]),
    ).toEqual([
      [
        '/usr/sbin/runuser',
        '-u',
        'agent',
        '--',
        '/bin/sh',
        '-c',
        'mkdir',
        '/home/agent',
        '/home/agent/.config',
      ],
      [
        '/usr/sbin/runuser',
        '-u',
        'sprite',
        '--',
        '/bin/sh',
        '-c',
        'mkdir',
        '/home/sprite',
        '/home/sprite/.config',
      ],
      [
        '/usr/sbin/runuser',
        '-u',
        'agent',
        '--',
        '/bin/sh',
        '-c',
        'write',
        '/home/agent',
        '/home/agent/.config/native.json',
      ],
      [
        '/usr/sbin/runuser',
        '-u',
        'agent',
        '--',
        '/bin/sh',
        '-c',
        'remove',
        '/home/agent',
        '/home/agent/.config/native.json',
      ],
    ]);
    const writes = vi.mocked(sprite.execFileHTTP).mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[2]?.input).toBe('private');
  });

  it('should reject escaped native paths before helper deployment or SDK execution', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-native-path-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    for (const path of [
      '/home/sprite/settings.json',
      '/home/agent/../sprite/settings.json',
      '/home/agent/.config/../settings.json',
      '/opt/open-agent/settings.json',
    ]) {
      await expect(
        writeOwnedFile(guestOf(sprite), path, 'private'),
      ).rejects.toThrow(/inside its owning account home/);
    }
    expect(sprite.execFile).not.toHaveBeenCalled();
    expect(sprite.execFileHTTP).not.toHaveBeenCalled();
  });
});
