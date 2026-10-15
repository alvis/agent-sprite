import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { HOMEBREW } from '#guest/homebrew';
import { HOMEBREW_INSTALLER, homebrew } from '#guest/install-tools/homebrew';

import {
  ranPrograms,
  runnerFor,
  toolsWith,
} from '../../fixtures/install-tools.js';

import type {
  HomebrewLayout,
  RunAsHomebrew,
} from '#guest/install-tools/homebrew';

const SCRIPT = '#!/bin/bash\necho installing Homebrew\n';
// scratch files belong to whoever runs the proof, whose user id may be any
const ANY_UID = { systemUidMax: Number.MAX_SAFE_INTEGER };
const OWNER = process.getuid?.() ?? 0;
const GROUP = process.getgid?.() ?? 0;
const INSTALLER = {
  url: 'https://example.test/install.sh',
  sha256: createHash('sha256').update(SCRIPT).digest('hex'),
};

/**
 * lays out a Homebrew under a scratch directory
 * @param root the directory the account's home goes in
 * @returns the account, home, prefix and brew command under it
 */
function layoutUnder(root: string): HomebrewLayout {
  const home = join(root, 'home');
  const prefix = join(home, '.linuxbrew');

  return {
    account: 'linuxbrew',
    home,
    prefix,
    brew: `${prefix}/bin/brew`,
  };
}

/**
 * lists the account as the password database would
 * @param layout the Homebrew paths
 * @param options another user id, group id or shell than the account's
 * @param options.uid the account's user id; the current user's by default, which owns every scratch file
 * @param options.gid the account's group id; the current user's by default
 * @param options.shell the account's shell
 * @returns the account's password database entry
 */
function entryOf(
  layout: HomebrewLayout,
  options: { uid?: number; gid?: number; shell?: string } = {},
): string {
  const { uid = OWNER, gid = GROUP, shell = '/usr/sbin/nologin' } = options;

  return `linuxbrew:x:${uid}:${gid}::${layout.home}:${shell}\n`;
}

/**
 * lays out an installed Homebrew under a scratch directory
 * @param root the directory the account's home goes in
 * @returns the layout, with its brew command in place
 */
async function installedUnder(root: string): Promise<HomebrewLayout> {
  const layout = layoutUnder(root);
  await mkdir(dirname(layout.brew), { recursive: true });
  await writeFile(layout.brew, '');

  return layout;
}

/**
 * builds a runner for the prefix's account that records what it ran and what
 * the installer script held when it ran
 * @returns the runner and the scripts it was handed
 */
function homebrewRunner(): {
  runAsHomebrew: ReturnType<typeof vi.fn<RunAsHomebrew>>;
  scripts: string[];
} {
  const scripts: string[] = [];
  const runAsHomebrew = vi.fn<RunAsHomebrew>(async (program, [file]) => {
    if (program === '/bin/bash' && file) {
      scripts.push(await readFile(file, 'utf8'));
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o755);
      expect((await stat(file)).mode & 0o777).toBe(0o644);
    }

    return '';
  });

  return { runAsHomebrew, scripts };
}

describe('fn:homebrew', () => {
  it('should keep every Homebrew path under the default prefix in one constant', () => {
    expect(HOMEBREW).toEqual({
      account: 'linuxbrew',
      home: '/home/linuxbrew',
      prefix: '/home/linuxbrew/.linuxbrew',
      brew: '/home/linuxbrew/.linuxbrew/bin/brew',
      gh: '/home/linuxbrew/.linuxbrew/opt/gh/bin/gh',
    });
  });

  it('should pin the official installer to one commit', () => {
    expect(HOMEBREW_INSTALLER.url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/Homebrew\/install\/[0-9a-f]{40}\/install\.sh$/,
    );
    expect(HOMEBREW_INSTALLER.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should create the account and prefix, then run the verified installer as that account', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': [
        new Error('no such account'),
        entryOf(layout),
      ],
      '/usr/bin/getent group linuxbrew': new Error('no such group'),
    });
    const downloadText = vi.fn(async () => SCRIPT);
    const { runAsHomebrew, scripts } = homebrewRunner();

    await homebrew(toolsWith({ run, downloadText }), runAsHomebrew, {
      layout,
      installer: INSTALLER,
      ...ANY_UID,
    }).ready();

    expect(ranPrograms(run)).toEqual([
      ['/usr/bin/getent', 'passwd', 'linuxbrew'],
      ['/usr/bin/getent', 'group', 'linuxbrew'],
      [
        '/usr/sbin/useradd',
        '--system',
        '--user-group',
        '--home-dir',
        layout.home,
        '--no-create-home',
        '--shell',
        '/usr/sbin/nologin',
        'linuxbrew',
      ],
      ['/usr/bin/getent', 'passwd', 'linuxbrew'],
      ['/usr/bin/id', '-nG', 'linuxbrew'],
      [
        '/usr/bin/install',
        '-d',
        '-o',
        'linuxbrew',
        '-g',
        'linuxbrew',
        '-m',
        '0755',
        layout.home,
        layout.prefix,
      ],
    ]);
    expect(downloadText).toHaveBeenCalledWith(INSTALLER.url);
    expect(runAsHomebrew.mock.calls.map(([program]) => program)).toEqual([
      '/bin/bash',
    ]);
    expect(scripts).toEqual([SCRIPT]);
  });

  it('should remove the installer once it has run', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const { runAsHomebrew } = homebrewRunner();

    await homebrew(
      toolsWith({ run, downloadText: vi.fn(async () => SCRIPT) }),
      runAsHomebrew,
      { layout, installer: INSTALLER, ...ANY_UID },
    ).ready();

    const file = runAsHomebrew.mock.calls[0]?.[1][0] ?? '';
    await expect(stat(dirname(file))).rejects.toThrow('ENOENT');
  });

  it('should refuse an installer whose digest differs from its pin', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const downloadText = vi.fn(async () => `${SCRIPT}tampered\n`);
    const { runAsHomebrew } = homebrewRunner();
    const brew = homebrew(toolsWith({ run, downloadText }), runAsHomebrew, {
      layout,
      installer: INSTALLER,
      ...ANY_UID,
    });

    await expect(brew.ready()).rejects.toThrow(
      'Homebrew installer digest does not match its pin',
    );
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it('should not try again within the same run once Homebrew failed to become ready', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const downloadText = vi.fn(async () => `${SCRIPT}tampered\n`);
    const brew = homebrew(
      toolsWith({ run, downloadText }),
      homebrewRunner().runAsHomebrew,
      { layout, installer: INSTALLER, ...ANY_UID },
    );

    await expect(brew.ready()).rejects.toThrow('digest');
    await expect(brew.ready()).rejects.toThrow('digest');

    expect(downloadText).toHaveBeenCalledOnce();
  });

  it('should update the formulae once per run instead of reinstalling an installed Homebrew', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const downloadText = vi.fn(async () => SCRIPT);
    const { runAsHomebrew } = homebrewRunner();
    const brew = homebrew(toolsWith({ run, downloadText }), runAsHomebrew, {
      layout,
      installer: INSTALLER,
      ...ANY_UID,
    });

    await brew.ready();
    await brew.ready();

    expect(ranPrograms(run)).toEqual([
      ['/usr/bin/getent', 'passwd', 'linuxbrew'],
      ['/usr/bin/id', '-nG', 'linuxbrew'],
    ]);
    expect(downloadText).not.toHaveBeenCalled();
    expect(runAsHomebrew.mock.calls).toEqual([[layout.brew, ['update']]]);
  });

  it('should recreate a lost account and its group under the ids its surviving home was made under', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    await mkdir(layout.home);
    const { gid } = await stat(layout.home);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': [
        new Error('no such account'),
        entryOf(layout, { gid }),
      ],
      '/usr/bin/getent group linuxbrew': new Error('no such group'),
      [`/usr/bin/getent passwd ${OWNER}`]: new Error('no such account'),
      [`/usr/bin/getent group ${gid}`]: new Error('no such group'),
    });

    await homebrew(
      toolsWith({ run, downloadText: vi.fn(async () => SCRIPT) }),
      homebrewRunner().runAsHomebrew,
      { layout, installer: INSTALLER, ...ANY_UID },
    ).ready();

    expect(ranPrograms(run)).toContainEqual([
      '/usr/sbin/groupadd',
      '--system',
      '--gid',
      String(gid),
      'linuxbrew',
    ]);
    expect(ranPrograms(run)).toContainEqual([
      '/usr/sbin/useradd',
      '--system',
      '--uid',
      String(OWNER),
      '--gid',
      'linuxbrew',
      '--home-dir',
      layout.home,
      '--no-create-home',
      '--shell',
      '/usr/sbin/nologin',
      'linuxbrew',
    ]);
    expect(ranPrograms(run).at(-1)?.[0]).toBe('/usr/bin/install');
  });

  it.each([
    [
      'its user id another account now holds',
      { [`/usr/bin/getent passwd ${OWNER}`]: 'someone:x:1:1::/:/bin/sh\n' },
      ANY_UID,
    ],
    [
      'its group id another group now holds',
      { [`/usr/bin/getent group ${GROUP}`]: 'others:x:1:\n' },
      ANY_UID,
    ],
    [
      'a group of the account name under another group id',
      { '/usr/bin/getent group linuxbrew': `linuxbrew:x:${GROUP + 1}:\n` },
      ANY_UID,
    ],
    ['a user id outside the system range', {}, { systemUidMax: OWNER - 1 }],
  ])(
    'should refuse a surviving home with %s before creating anything',
    async (_, listings, range) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-homebrew-'),
      );
      const layout = layoutUnder(directory.path);
      await mkdir(layout.home);
      const { gid } = await stat(layout.home);
      const run = runnerFor({
        '/usr/bin/getent passwd linuxbrew': new Error('no such account'),
        '/usr/bin/getent group linuxbrew': new Error('no such group'),
        [`/usr/bin/getent passwd ${OWNER}`]: new Error('no such account'),
        [`/usr/bin/getent group ${gid}`]: new Error('no such group'),
        ...listings,
      });
      const { runAsHomebrew } = homebrewRunner();

      await expect(
        homebrew(toolsWith({ run }), runAsHomebrew, {
          layout,
          installer: INSTALLER,
          ...range,
        }).ready(),
      ).rejects.toThrow('The Homebrew home belongs to another account');
      expect(ranPrograms(run).map(([program]) => program)).not.toEqual(
        expect.arrayContaining(['/usr/sbin/useradd']),
      );
      expect(ranPrograms(run).map(([program]) => program)).not.toEqual(
        expect.arrayContaining(['/usr/sbin/groupadd']),
      );
      expect(runAsHomebrew).not.toHaveBeenCalled();
    },
  );

  it('should install into a root-owned home that holds no Homebrew yet', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    // a root-owned directory stands in for a home a provider prepared
    const layout = { ...layoutUnder(directory.path), home: '/usr' };
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const { runAsHomebrew } = homebrewRunner();

    await homebrew(
      toolsWith({ run, downloadText: vi.fn(async () => SCRIPT) }),
      runAsHomebrew,
      { layout, installer: INSTALLER, ...ANY_UID },
    ).ready();

    expect(ranPrograms(run).at(-1)?.slice(0, 2)).toEqual([
      '/usr/bin/install',
      '-d',
    ]);
    expect(runAsHomebrew.mock.calls.map(([program]) => program)).toEqual([
      '/bin/bash',
    ]);
  });

  it('should refuse a root-owned home that already holds Homebrew', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = {
      ...(await installedUnder(directory.path)),
      home: '/usr',
    };
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const { runAsHomebrew } = homebrewRunner();

    await expect(
      homebrew(toolsWith({ run }), runAsHomebrew, {
        layout,
        installer: INSTALLER,
        ...ANY_UID,
      }).ready(),
    ).rejects.toThrow('The Homebrew home belongs to another account');
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it.each([
    ['another account', { uid: OWNER + 1 }],
    ['another group', { gid: GROUP + 1 }],
  ])('should refuse a home %s owns', async (_, ids) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout, ids),
    });
    const { runAsHomebrew } = homebrewRunner();

    await expect(
      homebrew(toolsWith({ run }), runAsHomebrew, {
        layout,
        installer: INSTALLER,
        ...ANY_UID,
      }).ready(),
    ).rejects.toThrow('The Homebrew home belongs to another account');
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it('should refuse to run brew in a prefix another account owns', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    // a root-owned directory stands in for a prefix someone else owns
    const layout = {
      ...(await installedUnder(directory.path)),
      prefix: '/usr',
    };
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
    });
    const { runAsHomebrew } = homebrewRunner();

    await expect(
      homebrew(toolsWith({ run }), runAsHomebrew, {
        layout,
        installer: INSTALLER,
        ...ANY_UID,
      }).ready(),
    ).rejects.toThrow('The Homebrew prefix belongs to another account');
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it.each([
    ['root', 0],
    ['an ordinary user', 1000],
  ])('should refuse an account with the user id of %s', async (_, uid) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout, { uid }),
    });
    const { runAsHomebrew } = homebrewRunner();

    await expect(
      homebrew(toolsWith({ run }), runAsHomebrew, {
        layout,
        installer: INSTALLER,
      }).ready(),
    ).rejects.toThrow('The Homebrew account is not a system account');
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it('should check an existing account before changing it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout, {
        uid: 0,
        shell: '/bin/bash',
      }),
    });

    await expect(
      homebrew(toolsWith({ run }), homebrewRunner().runAsHomebrew, {
        layout,
        installer: INSTALLER,
      }).ready(),
    ).rejects.toThrow('The Homebrew account is not a system account');
    expect(ranPrograms(run).map(([program]) => program)).not.toContain(
      '/usr/sbin/usermod',
    );
  });

  it('should refuse an account in a group that may use sudo', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout),
      '/usr/bin/id -nG linuxbrew': 'linuxbrew sudo\n',
    });
    const { runAsHomebrew } = homebrewRunner();

    await expect(
      homebrew(toolsWith({ run }), runAsHomebrew, {
        layout,
        installer: INSTALLER,
        ...ANY_UID,
      }).ready(),
    ).rejects.toThrow('The Homebrew account may use sudo');
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it('should join a group of the account name left without its account', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': [
        new Error('no such account'),
        entryOf(layout),
      ],
    });

    await homebrew(
      toolsWith({ run, downloadText: vi.fn(async () => SCRIPT) }),
      homebrewRunner().runAsHomebrew,
      { layout, installer: INSTALLER, ...ANY_UID },
    ).ready();

    expect(ranPrograms(run)[2]?.slice(0, 4)).toEqual([
      '/usr/sbin/useradd',
      '--system',
      '--gid',
      'linuxbrew',
    ]);
  });

  it('should take the login shell and password from an existing account', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({
      '/usr/bin/getent passwd linuxbrew': entryOf(layout, {
        shell: '/bin/bash',
      }),
    });

    await homebrew(toolsWith({ run }), homebrewRunner().runAsHomebrew, {
      layout,
      installer: INSTALLER,
      ...ANY_UID,
    }).ready();

    expect(ranPrograms(run)).toContainEqual([
      '/usr/sbin/usermod',
      '--home',
      layout.home,
      '--shell',
      '/usr/sbin/nologin',
      '--lock',
      'linuxbrew',
    ]);
  });

  it('should refuse an account the password database lists without a user id', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = await installedUnder(directory.path);
    const run = runnerFor({ '/usr/bin/getent passwd linuxbrew': 'linuxbrew' });
    const { runAsHomebrew } = homebrewRunner();

    await expect(
      homebrew(toolsWith({ run }), runAsHomebrew, {
        layout,
        installer: INSTALLER,
        ...ANY_UID,
      }).ready(),
    ).rejects.toThrow('The Homebrew account has no valid user or group id');
    expect(runAsHomebrew).not.toHaveBeenCalled();
  });

  it('should run brew as the prefix account and pass through what it captures', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const runAsHomebrew = vi.fn<RunAsHomebrew>(async () => '{}');

    const output = await homebrew(toolsWith(), runAsHomebrew, { layout }).run(
      ['info', '--json=v2', 'git'],
      true,
    );

    expect(output).toBe('{}');
    expect(runAsHomebrew).toHaveBeenCalledWith(
      layout.brew,
      ['info', '--json=v2', 'git'],
      true,
    );
  });

  it('should tell an installed keg and a link into the prefix from anything else', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-homebrew-'),
    );
    const layout = layoutUnder(directory.path);
    const keg = join(layout.prefix, 'Cellar', 'git', '2.56.0', 'bin', 'git');
    await mkdir(dirname(keg), { recursive: true });
    await writeFile(keg, '');
    await mkdir(join(layout.prefix, 'opt'));
    await symlink(
      join(layout.prefix, 'Cellar', 'git', '2.56.0'),
      join(layout.prefix, 'opt', 'git'),
    );
    const outside = join(directory.path, 'git');
    await writeFile(outside, '');
    await symlink(keg, join(directory.path, 'into'));
    await symlink(outside, join(directory.path, 'away'));
    const brew = homebrew(toolsWith(), vi.fn<RunAsHomebrew>(), { layout });

    expect(await brew.has('git')).toBe(true);
    expect(await brew.has('jj')).toBe(false);
    expect(await brew.owns(join(directory.path, 'into'))).toBe(true);
    expect(await brew.owns(join(directory.path, 'away'))).toBe(false);
    expect(await brew.owns(join(directory.path, 'missing'))).toBe(false);
  });
});
