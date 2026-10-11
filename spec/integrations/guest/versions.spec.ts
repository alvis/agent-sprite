import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readInstalledVersions } from '#integrations/guest/versions';

import { createFilesystemSprite } from '../../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

const commands = [
  ['node', '/usr/local/bin/node', '--version'],
  ['git', '/usr/local/bin/git', '--version'],
  ['jj', '/usr/local/bin/jj', '--version'],
  ['gh', '/usr/local/bin/gh', '--version'],
  ['tailscale', '/usr/local/bin/tailscale', 'version'],
  ['claude', '/home/agent/.local/bin/claude', '--version'],
  ['codex', '/home/agent/.local/bin/codex', '--version'],
  ['t3', '/home/agent/.local/bin/t3', '--version'],
  ['bun', '/home/agent/.local/bin/bun', '--version'],
] as const;

describe('fn:readInstalledVersions', () => {
  it('should probe every tool as agent with the managed Node PATH and home', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-version-probes-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: `${args.at(-2)}\n`,
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const versions = await readInstalledVersions(sprite);

    expect(versions).toEqual(
      Object.fromEntries(commands.map(([name, path]) => [name, path])),
    );
    expect(execute.mock.calls).toEqual(
      commands.map(([, path, flag]) => [
        '/usr/bin/sudo',
        [
          '-n',
          '-E',
          '--',
          '/usr/sbin/runuser',
          '-u',
          'agent',
          '--',
          '/usr/bin/env',
          '--chdir=/home/agent',
          'PATH=/home/agent/.local/bin:/opt/agent-sprite/node/bin:/usr/local/bin:/usr/bin:/bin',
          path,
          flag,
        ],
        expect.objectContaining({ timeout: expect.any(Number) }),
      ]),
    );
  });

  it('should report the provider failure when a version command cannot find Node', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-version-node-failure-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: '',
      stderr: args.includes('/home/agent/.local/bin/codex')
        ? "env: 'node': No such file or directory"
        : '',
      exitCode: args.includes('/home/agent/.local/bin/codex') ? 127 : 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(readInstalledVersions(sprite)).rejects.toEqual(
      expect.objectContaining({
        code: 'PROVIDER',
        message: expect.stringMatching(
          /status 127: env: 'node': No such file or directory/u,
        ),
      }),
    );
  });

  it('should preserve an SDK transport failure as the original cause', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-version-transport-'),
    );
    const original = new Error('version probe transport unavailable');
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => {
      if (args.includes('/home/agent/.local/bin/codex')) {
        throw original;
      }

      return { stdout: 'version\n', stderr: '', exitCode: 0 };
    });
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(readInstalledVersions(sprite)).rejects.toBe(original);
  });
});
