import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ensurePrivateDirectory,
  ownGuestFile,
  removeOwnedFile,
  runAsAgent,
  writeOwnedFile,
} from '#integrations/guest/account';

import {
  createFilesystemSprite,
  executeNativeConfiguration,
} from '../../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { FilesystemChownRecord } from '../../mocks/sprites.js';

describe('fn:runAsAgent', () => {
  it('should start native commands in the runtime home instead of the provider shell directory', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-native-home-'),
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

    const result = await runAsAgent(sprite, ['/bin/pwd']);

    expect(result.stdout.trim()).toBe('/home/agent');
  });
});

describe('fn:ownGuestFile', () => {
  it('should transfer ownership using validated guest numeric IDs', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-account-id-'),
    );
    const chownRecords: FilesystemChownRecord[] = [];
    const sprite = createFilesystemSprite({
      root: directory.path,
      chownRecords,
      execute: async (_file, args = []) => ({
        stdout: args.at(-2) === '-u' ? '1001\n' : '1002\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    const path = '/opt/agent-sprite/native.json';
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
    await sprite.filesystem().writeFile(path, '{}');

    await ownGuestFile(sprite, path);

    expect(sprite.filesystem().chown).toHaveBeenCalledExactlyOnceWith(path, {
      uid: 1001,
      gid: 1002,
      asRoot: true,
    });
    expect(chownRecords).toEqual([{ path, uid: 1001, gid: 1002 }]);
  });

  it('should refuse nonnumeric and root user or group IDs before changing file ownership', async () => {
    for (const [uid, gid] of [
      ['invalid', '1000'],
      ['0', '1000'],
      ['1000', 'invalid'],
      ['1000', '0'],
    ]) {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-account-id-'),
      );
      const execution = {
        execFile: vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
          stdout: args.includes('-u') ? uid! : gid!,
          stderr: '',
          exitCode: 0,
        })),
      } satisfies Partial<Sprite>;
      const sprite = createFilesystemSprite({
        root: directory.path,
        execute: execution.execFile,
      });
      const path = '/opt/agent-sprite/native.json';
      await sprite.filesystem().mkdir('/opt/agent-sprite', {
        recursive: true,
      });
      await sprite.filesystem().writeFile(path, '{"userSetting":true}');

      await expect(ownGuestFile(sprite, path)).rejects.toEqual(
        expect.objectContaining({ code: 'PREFLIGHT' }),
      );
      expect(sprite.filesystem().chown).not.toHaveBeenCalled();
      expect(await readFile(join(directory.path, path), 'utf8')).toBe(
        '{"userSetting":true}',
      );
    }
  });

  it('should refuse home and noncanonical root ownership paths before any SDK call', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-root-ownership-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });

    for (const path of [
      '/home/agent/native.json',
      '/home/sprite/native.json',
      '/opt/../home/agent/native.json',
      'relative.json',
    ]) {
      await expect(ownGuestFile(sprite, path)).rejects.toThrow(
        /home files must be changed as their owning account/,
      );
    }
    expect(sprite.execFile).not.toHaveBeenCalled();
    expect(sprite.filesystem().chown).not.toHaveBeenCalled();
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
      join(tmpdir(), 'agent-sprite-native-dispatch-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await ensurePrivateDirectory(sprite, '/home/agent/.config');
    await ensurePrivateDirectory(sprite, '/home/sprite/.config', 'sprite');
    await writeOwnedFile(sprite, '/home/agent/.config/native.json', 'private');
    await removeOwnedFile(sprite, '/home/agent/.config/native.json');

    const helper = '/opt/agent-sprite/native-files.js';
    const commands = vi
      .mocked(sprite.execFile)
      .mock.calls.map(([, args]) => args ?? [])
      .filter((args) => args.includes(helper));
    expect(commands.map((args) => args.slice(3, 7))).toEqual([
      ['/usr/sbin/runuser', '-u', 'agent', '--'],
      ['/usr/sbin/runuser', '-u', 'sprite', '--'],
      ['/usr/sbin/runuser', '-u', 'agent', '--'],
    ]);
    expect(commands.map((args) => args.at(-3))).toEqual([
      'mkdir',
      'mkdir',
      'remove',
    ]);
    const writes = vi.mocked(sprite.execFileHTTP).mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toEqual([
      '-n',
      '-E',
      '--',
      '/usr/sbin/runuser',
      '-u',
      'agent',
      '--',
      '/opt/agent-sprite/node/bin/node',
      helper,
      'write',
      '/home/agent',
      '/home/agent/.config/native.json',
    ]);
    expect(writes[0]?.[2]?.input).toBe('private');
    expect(sprite.filesystem().writeFile).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/home\//),
      expect.anything(),
      expect.anything(),
    );
    expect(sprite.filesystem().chown).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/home\//),
      expect.anything(),
    );
  });

  it('should reject escaped native paths before helper deployment or SDK execution', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-native-path-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    for (const path of [
      '/home/sprite/settings.json',
      '/home/agent/../sprite/settings.json',
      '/home/agent/.config/../settings.json',
      '/opt/agent-sprite/settings.json',
    ]) {
      await expect(writeOwnedFile(sprite, path, 'private')).rejects.toThrow(
        /inside its owning account home/,
      );
    }
    expect(sprite.filesystem().writeFile).not.toHaveBeenCalled();
    expect(sprite.execFile).not.toHaveBeenCalled();
    expect(sprite.execFileHTTP).not.toHaveBeenCalled();
  });
});
