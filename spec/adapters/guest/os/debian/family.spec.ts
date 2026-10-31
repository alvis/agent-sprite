import { describe, expect, it } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';

import type { OsRelease } from '#domain/guest';

const RELEASE = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  arch: 'x86_64',
  libc: 'glibc',
} satisfies OsRelease;

describe('Debian Homebrew support', () => {
  it.each([
    { release: { ...RELEASE, libc: 'musl' }, supported: false },
    { release: { ...RELEASE, id: 'linuxmint' }, supported: false },
    { release: { ...RELEASE, versionId: '11' }, supported: false },
    { release: { ...RELEASE, versionId: '13' }, supported: true },
    { release: { ...RELEASE, versionId: 'unstable' }, supported: false },
    {
      release: { ...RELEASE, id: 'ubuntu', versionId: '22' },
      supported: false,
    },
  ] satisfies Array<{ release: OsRelease; supported: boolean }>)(
    'should judge bottle compatibility for $release',
    ({ release, supported }) => {
      expect(debianFamily.homebrew(release)).toMatchObject({ supported });
    },
  );
});

describe('Debian command accounts', () => {
  it('should run an agent command from the agent home', () => {
    expect(debianFamily.runAs('agent')).toEqual([
      'runuser',
      '-u',
      'agent',
      '--',
      'env',
      '--chdir=/home/agent',
    ]);
  });
});
