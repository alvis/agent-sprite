import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SELECTION } from '#core/catalog';
import { readInstalledVersions } from '#integrations/guest/versions';

import { createFilesystemSprite, guestOf } from '../../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

const commands = [
  ['guest-node', '/opt/open-agent/node/bin/node', '--version'],
  ['git', '/usr/local/bin/git', '--version'],
  ['jj', '/usr/local/bin/jj', '--version'],
  ['gh', '/usr/local/bin/gh', '--version'],
  ['node', '/usr/local/bin/node', '--version'],
  ['pnpm', '/usr/local/bin/pnpm', '--version'],
  ['python3', '/usr/local/bin/python3', '--version'],
  ['uv', '/usr/local/bin/uv', '--version'],
  ['rustup', '/usr/local/bin/rustup', '--version'],
  ['httpie', '/usr/local/bin/http', '--version'],
  ['rust', '/usr/local/bin/rustc', '--version'],
  ['tailscale', '/usr/local/bin/tailscale', 'version'],
  ['claude', '/home/agent/.local/bin/claude', '--version'],
  ['codex', '/home/agent/.local/bin/codex', '--version'],
  ['t3', '/home/agent/.local/bin/t3', '--version'],
  ['bun', '/home/agent/.local/bin/bun', '--version'],
] as const;

afterEach(() => {
  vi.doUnmock('#core/harnesses');
  vi.resetModules();
});

describe('fn:readInstalledVersions', () => {
  it('should probe every tool as agent with the agent PATH and home', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-version-probes-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: `${args.at(-2)}\n`,
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const versions = await readInstalledVersions(guestOf(sprite), {
      ...DEFAULT_SELECTION,
      network: 'tailscale',
    });

    expect(versions).toEqual(
      Object.fromEntries(commands.map(([name, path]) => [name, path])),
    );
    expect(execute.mock.calls).toEqual(
      commands.map(([name, path, flag]) => [
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
          'PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin',
          // rustup, and the proxies it links, would fetch a toolchain when asked
          ...(name === 'rustup' || name === 'rust'
            ? ['/usr/bin/env', 'RUSTUP_AUTO_INSTALL=0']
            : []),
          path,
          flag,
        ],
        expect.objectContaining({ timeout: expect.any(Number) }),
      ]),
    );
  });

  it('should probe no network tool when the selected network installs none', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-version-none-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: `${args.at(-2)}\n`,
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const versions = await readInstalledVersions(guestOf(sprite), {
      ...DEFAULT_SELECTION,
      network: 'none',
    });

    expect(versions).not.toHaveProperty('tailscale');
    expect(execute.mock.calls.map(([, args]) => args?.at(-2))).not.toContain(
      '/usr/local/bin/tailscale',
    );
    expect(Object.keys(versions)).toEqual(
      commands.filter(([name]) => name !== 'tailscale').map(([name]) => name),
    );
  });

  it('should probe the ACP adapter a selected harness provides', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-version-adapter-'),
    );
    vi.resetModules();
    vi.doMock('#core/harnesses', async (importOriginal) => {
      const original = await importOriginal<typeof import('#core/harnesses')>();
      const [driver] = original.harnessDrivers(['codex']);

      return {
        ...original,
        harnessDrivers: () => [
          {
            ...driver,
            acpAdapter: {
              install: {
                component: 'codex-acp',
                source: { kind: 'npm', package: 'codex-acp' },
                versionProbe: {
                  program: '/home/agent/.local/bin/codex-acp',
                  arguments: ['--version'],
                },
              },
              launch: { program: 'codex-acp', arguments: [] },
            },
          },
        ],
      };
    });
    const { readInstalledVersions: read } =
      await import('#integrations/guest/versions');
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: `${args.at(-2)}\n`,
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const versions = await read(guestOf(sprite), DEFAULT_SELECTION);

    expect(versions['codex-acp']).toBe('/home/agent/.local/bin/codex-acp');
    expect(execute.mock.calls.map(([, args]) => args?.at(-2))).toContain(
      '/home/agent/.local/bin/codex-acp',
    );
  });

  it('should report the provider failure when a version command cannot find Node', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-version-node-failure-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: '',
      stderr: args.includes('/home/agent/.local/bin/codex')
        ? "env: 'node': No such file or directory"
        : '',
      exitCode: args.includes('/home/agent/.local/bin/codex') ? 127 : 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(
      readInstalledVersions(guestOf(sprite), DEFAULT_SELECTION),
    ).rejects.toEqual(
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
      join(tmpdir(), 'open-agent-version-transport-'),
    );
    const original = new Error('version probe transport unavailable');
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => {
      if (args.includes('/home/agent/.local/bin/codex')) {
        throw original;
      }

      return { stdout: 'version\n', stderr: '', exitCode: 0 };
    });
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(
      readInstalledVersions(guestOf(sprite), DEFAULT_SELECTION),
    ).rejects.toBe(original);
  });
});
