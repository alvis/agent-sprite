import { lstat, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOMEBREW } from '#guest/homebrew';

const { root, behaviour, runChild, recordLink } = await vi.hoisted(async () => {
  const { vi: hoisted } = await import('vitest');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir: temporaryRoot } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  return {
    root: await mkdtemp(joinPath(temporaryRoot(), 'open-agent-context-')),
    behaviour: { bootstrapFails: true },
    runChild: hoisted.fn(async () => 'captured'),
    recordLink: hoisted.fn(async () => undefined),
  };
});

vi.mock('#guest/guest-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#guest/guest-root')>()),
  GUEST_ROOT: root,
  GUEST_KERNEL: `${root}/guest`,
}));

vi.mock('#guest/native-files', () => ({
  resolveTrustedFile: async (path: string) => path,
}));

vi.mock('#guest/run-child', () => ({ runChild }));

vi.mock('#guest/install-tools/link-record', () => ({ recordLink }));

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    if (behaviour.bootstrapFails) {
      throw new Error('bootstrap failed');
    }

    return '';
  },
}));

const outcomesPath = join(root, 'install-outcomes.json');

/**
 * loads the context the way the installer does, which runs the Node gate on import
 * @returns the loaded context
 */
async function loadContext(): Promise<
  typeof import('#guest/install-tools/context')
> {
  vi.resetModules();

  return import('#guest/install-tools/context');
}

beforeEach(async () => {
  behaviour.bootstrapFails = true;
  await mkdir(root, { recursive: true });
  await rm(outcomesPath, { force: true });
});

afterAll(() => {
  vi.resetModules();
});

describe('script:install-tools context', () => {
  it('should carry on with the Node it runs on when the Node gate recorded its own failure', async () => {
    await writeFile(
      outcomesPath,
      JSON.stringify({
        'guest-node': {
          status: 'failed',
          error: 'latest version could not be resolved',
        },
      }),
    );

    await expect(loadContext()).resolves.toBeDefined();
  });

  it.each([
    ['records nothing', undefined],
    [
      'recorded Node as installed',
      { 'guest-node': { status: 'installed', version: '24.0.0' } },
    ],
    ['recorded another component only', { jj: { status: 'failed' } }],
  ] as const)(
    'should end the run when the bootstrap fails and it %s',
    async (_label, outcomes) => {
      if (outcomes) {
        await writeFile(outcomesPath, JSON.stringify(outcomes));
      }

      await expect(loadContext()).rejects.toThrow('bootstrap failed');
    },
  );

  it('should continue when the bootstrap succeeds', async () => {
    behaviour.bootstrapFails = false;

    await expect(loadContext()).resolves.toBeDefined();
  });

  it('should run brew without blocking as the prefix account, with a fixed Homebrew environment and no ownership descriptor', async () => {
    behaviour.bootstrapFails = false;
    const { log, runAsHomebrew } = await loadContext();

    const output = await runAsHomebrew(
      HOMEBREW.brew,
      ['info', '--json=v2', 'git'],
      true,
    );

    expect(output).toBe('captured');
    expect(runChild).toHaveBeenCalledWith(
      '/usr/sbin/runuser',
      [
        '-u',
        HOMEBREW.account,
        '--',
        '/usr/bin/env',
        '-i',
        `HOME=${HOMEBREW.home}`,
        `USER=${HOMEBREW.account}`,
        `LOGNAME=${HOMEBREW.account}`,
        'PATH=/usr/bin:/bin',
        'LANG=C.UTF-8',
        'NONINTERACTIVE=1',
        'HOMEBREW_NO_SUDO=1',
        'HOMEBREW_NO_AUTO_UPDATE=1',
        'HOMEBREW_NO_ANALYTICS=1',
        'HOMEBREW_NO_ENV_HINTS=1',
        'HOMEBREW_NO_BOTTLE_SOURCE_FALLBACK=1',
        HOMEBREW.brew,
        'info',
        '--json=v2',
        'git',
      ],
      expect.objectContaining({
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        cwd: HOMEBREW.home,
        stdio: ['ignore', 'pipe', log],
      }),
    );
  });

  it('should send what brew prints to the private log unless it is captured', async () => {
    behaviour.bootstrapFails = false;
    const { log, runAsHomebrew } = await loadContext();

    await runAsHomebrew(HOMEBREW.brew, ['update']);

    expect(runChild).toHaveBeenLastCalledWith(
      '/usr/sbin/runuser',
      expect.any(Array),
      expect.objectContaining({ stdio: ['ignore', log, log] }),
    );
  });

  it('should replace the link and hand it to the link record under the guest root', async () => {
    behaviour.bootstrapFails = false;
    const { link } = await loadContext();
    const path = join(root, 'linked');
    await rm(path, { force: true });
    await link(join(root, 'first'), path);

    await link(join(root, 'second'), path);

    expect(await readlink(path)).toBe(join(root, 'second'));
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(recordLink).toHaveBeenLastCalledWith(
      join(root, 'links'),
      join(root, 'second'),
      path,
    );
  });
});
