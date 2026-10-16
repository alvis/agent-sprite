import {
  mkdir,
  mkdtempDisposable,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Secret } from '#integrations/guest/session/secret';

import {
  configureGit,
  configureGithub,
  configureRuntimeEnv,
} from '#integrations/native/git';
import { HOMEBREW_GH } from '#tools/accounts';

import {
  createFilesystemSprite,
  createNativeCommandExecutor,
  guestOf,
  sessionGuestOf,
} from '../../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

const success = { stdout: '', stderr: '', exitCode: 0 };
const protectedGh = HOMEBREW_GH;

function protectedGithubArgs(user: string, args: string[]): string[] {
  return [
    '-n',
    '-E',
    '--',
    '/usr/sbin/runuser',
    '-u',
    user,
    '--',
    '/usr/bin/env',
    `--chdir=/home/${user}`,
    `HOME=/home/${user}`,
    'PATH=/usr/local/bin:/usr/bin:/bin',
    protectedGh,
    ...args,
  ];
}

describe('fn:configureGit', () => {
  it('should replace the persisted committer when author and committer identities are reconfigured', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-git-'),
    );
    const first = {
      authorName: 'First Author',
      authorEmail: 'first@example.test',
      committerName: 'First Committer',
      committerEmail: 'committer-first@example.test',
    };
    const second = {
      authorName: 'Second Author',
      authorEmail: 'second@example.test',
      committerName: 'Second Committer',
      committerEmail: 'committer-second@example.test',
    };
    const commands = [first, second].flatMap((identity) => [
      {
        argv: ['git', 'config', '--global', 'user.name', identity.authorName],
        result: success,
      },
      {
        argv: ['git', 'config', '--global', 'user.email', identity.authorEmail],
        result: success,
      },
      {
        argv: ['git', 'config', '--global', 'user.useConfigOnly', 'true'],
        result: success,
      },
      {
        argv: [
          'jj',
          'config',
          'set',
          '--user',
          'user.name',
          identity.authorName,
        ],
        result: success,
      },
      {
        argv: [
          'jj',
          'config',
          'set',
          '--user',
          'user.email',
          identity.authorEmail,
        ],
        result: success,
      },
    ]);
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor(commands),
    });
    const committerPath = join(
      directory.path,
      '/home/agent/.config/open-agent/committer.json',
    );

    await configureGit(guestOf(sprite), first);
    const initial: unknown = JSON.parse(await readFile(committerPath, 'utf8'));
    await configureGit(guestOf(sprite), second);
    const updated: unknown = JSON.parse(await readFile(committerPath, 'utf8'));

    expect(initial).toEqual({
      name: first.committerName,
      email: first.committerEmail,
    });
    expect(updated).toEqual({
      name: second.committerName,
      email: second.committerEmail,
    });
  });
});

describe('fn:configureGithub', () => {
  it('should route native authentication to the selected hostname and supply credentials only over stdin', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-github-'),
    );
    const configDirectory = join(directory.path, '/home/agent/.config');
    await mkdir(configDirectory, { recursive: true, mode: 0o755 });
    await writeFile(join(configDirectory, 'unrelated'), 'preserved');
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor(
        ['github.enterprise.test', 'github.com'].flatMap((host) =>
          ['agent', 'sprite'].flatMap(() => [
            {
              argv: [protectedGh, 'auth', 'setup-git', '--hostname', host],
              result: success,
            },
            {
              argv: [protectedGh, 'auth', 'status', '--hostname', host],
              result: success,
            },
          ]),
        ),
      ),
    });
    const login = vi.fn<Sprite['execFileHTTP']>(async () => success);
    Object.assign(sprite, { execFileHTTP: login });

    await configureGithub(
      sessionGuestOf(sprite),
      Secret.fromHost('github', 'enterprise-token'),
      {
        hostname: 'github.enterprise.test',
        shellAccounts: ['sprite'],
      },
    );
    await configureGithub(
      sessionGuestOf(sprite),
      Secret.fromHost('github', 'default-token'),
      {
        shellAccounts: ['sprite'],
      },
    );

    expect(
      login.mock.calls.map(([file, args, options]) => ({
        file,
        args,
        input: options?.input,
      })),
    ).toEqual(
      [
        { host: 'github.enterprise.test', token: 'enterprise-token' },
        { host: 'github.com', token: 'default-token' },
      ].flatMap(({ host, token }) =>
        ['agent', 'sprite'].map((user) => ({
          file: '/usr/bin/sudo',
          args: protectedGithubArgs(user, [
            'auth',
            'login',
            '--hostname',
            host,
            '--git-protocol',
            'https',
            '--with-token',
          ]),
          input: token,
        })),
      ),
    );
    expect(
      vi
        .mocked(sprite.execFile)
        .mock.calls.filter(([, args]) => args?.includes(protectedGh) === true)
        .map(([file, args]) => ({ file, args })),
    ).toEqual(
      ['github.enterprise.test', 'github.com'].flatMap((host) =>
        ['agent', 'sprite'].flatMap((user) => [
          {
            file: '/usr/bin/sudo',
            args: protectedGithubArgs(user, [
              'auth',
              'setup-git',
              '--hostname',
              host,
            ]),
          },
          {
            file: '/usr/bin/sudo',
            args: protectedGithubArgs(user, [
              'auth',
              'status',
              '--hostname',
              host,
            ]),
          },
        ]),
      ),
    );
    expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(configDirectory, 'gh'))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(configDirectory, 'unrelated'), 'utf8')).toBe(
      'preserved',
    );
    const providerDirectory = join(directory.path, '/home/sprite/.config');
    expect((await stat(providerDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(providerDirectory, 'gh'))).mode & 0o777).toBe(
      0o700,
    );
  });

  it('should explain a rejected native login without leaking its stdin credential', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-github-error-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    Object.assign(sprite, {
      execFileHTTP: vi.fn<Sprite['execFileHTTP']>(async () => ({
        ...success,
        exitCode: 1,
        stderr:
          'mkdir /home/agent/.config/gh: permission denied\nsecret-github-value',
      })),
    });

    const error = await configureGithub(
      sessionGuestOf(sprite),
      Secret.fromHost('github', 'secret-github-value'),
      { shellAccounts: ['sprite'] },
    ).catch((failure: Error) => failure);
    expect(error).toEqual(
      expect.objectContaining({
        name: 'CommandFault',
        code: 'PROVIDER',
        message: expect.stringMatching(
          /^(?![\s\S]*secret-github-value)[\s\S]*GitHub[\s\S]*agent[\s\S]*auth login[\s\S]*exit 1[\s\S]*permission denied[\s\S]*\[REDACTED\]/,
        ),
      }),
    );
  });

  it('should reject failed status verification even after native login and Git credential setup succeeded', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-github-status-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([
        {
          argv: [protectedGh, 'auth', 'setup-git', '--hostname', 'github.com'],
          result: success,
        },
        {
          argv: [protectedGh, 'auth', 'status', '--hostname', 'github.com'],
          result: { ...success, exitCode: 1, stderr: 'Token is invalid' },
        },
      ]),
    });
    Object.assign(sprite, {
      execFileHTTP: vi.fn<Sprite['execFileHTTP']>(async () => success),
    });

    await expect(
      configureGithub(
        sessionGuestOf(sprite),
        Secret.fromHost('github', 'github-value'),
        {
          shellAccounts: ['sprite'],
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'CommandFault',
        code: 'PROVIDER',
        message: expect.stringMatching(
          /GitHub[\s\S]*agent[\s\S]*auth status[\s\S]*exit 1[\s\S]*Token is invalid/,
        ),
      }),
    );
  });
});

describe('fn:configureRuntimeEnv', () => {
  it('should persist only approved runtime values and reject management credentials before rewriting the file', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-runtime-env-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const approved = {
      WORKSTATION_CONTEXT: 'quoted "value"\nsecond line',
      USER_TAG: 'preserved',
    };
    const path = join(
      directory.path,
      '/home/agent/.config/open-agent/runtime-env.json',
    );

    await configureRuntimeEnv(sessionGuestOf(sprite), approved);
    await expect(
      configureRuntimeEnv(sessionGuestOf(sprite), {
        SPRITES_TOKEN: 'private',
        HOME: '/malicious',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(approved);
  });
});
