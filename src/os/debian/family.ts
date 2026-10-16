import { guestAsset } from '#guest/assets';
import { ROOT_ONLY_MODE } from '#os/contracts';
import { OWNER_HOMES } from '#tools/accounts';

import type { HomebrewSupport, OsFamily, OsRelease } from '#os/contracts';
import type { ToolOwner } from '#tools/contracts';

/**
 * the first release of each distribution whose glibc (2.35 or newer) Homebrew's
 * bottles run on; a distribution not listed is refused, since its glibc is
 * unknown
 */
const HOMEBREW_MINIMUM_RELEASES: Readonly<Record<string, string>> = {
  debian: '12',
  ubuntu: '22.04',
};

/** system packages the Homebrew installer and `brew` run before any bottle pours */
const HOMEBREW_PREREQUISITES = [
  'ca-certificates',
  'curl',
  'file',
  'git',
  'procps',
];

/** system packages every setup installs before any tool: TLS roots, the downloader, the schedule's cron and the jq root's programs read JSON with */
const BOOTSTRAP_PACKAGES = ['ca-certificates', 'curl', 'cron', 'jq'];

/**
 * the Debian family: Debian itself and every distribution that names it in
 * `ID_LIKE`, such as Ubuntu, set up with apt, dpkg and runuser
 */
export const debianFamily: OsFamily = {
  id: 'debian',
  matches: (osRelease) =>
    osRelease.ID === 'debian' ||
    (osRelease.ID_LIKE ?? '').split(/\s+/u).includes('debian'),
  shell: '/bin/dash',
  sessionCommands: [
    'setsid',
    'flock',
    'timeout',
    'base64',
    'env',
    'mktemp',
    'sed',
    'cut',
    'sleep',
    'rm',
    'mv',
    'runuser',
  ],
  runAs,
  bootstrapPackages: () => BOOTSTRAP_PACKAGES,
  homebrew,
  library: guestAsset('os/debian/lib.sh', ROOT_ONLY_MODE),
  updaterFragment: guestAsset('os/debian/update-system.sh', ROOT_ONLY_MODE),
};

/**
 * renders the program prefix that runs a command as an account from its home,
 * with `runuser`, which needs no PAM session and no sudo rule
 * @param account account the command runs as
 * @returns the prefix; empty for root
 */
function runAs(account: ToolOwner): readonly string[] {
  if (account === 'root') {
    return [];
  }

  return [
    'runuser',
    '-u',
    account,
    '--',
    'env',
    `--chdir=${OWNER_HOMES[account]}`,
  ];
}

/**
 * tells whether Homebrew's bottles run on a release: glibc, on a release
 * whose glibc is recent enough; both supported architectures have bottles
 * @param release the guest's release
 * @returns the support and its prerequisites, or why it is unsupported
 */
function homebrew(release: OsRelease): HomebrewSupport {
  const name = `${release.id} ${release.versionId}`;
  if (release.libc !== 'glibc') {
    return {
      supported: false,
      reason: `Homebrew needs glibc, but ${name} links against ${release.libc}`,
    };
  }
  const minimum = Object.hasOwn(HOMEBREW_MINIMUM_RELEASES, release.id)
    ? HOMEBREW_MINIMUM_RELEASES[release.id]
    : undefined;
  if (minimum === undefined) {
    return {
      supported: false,
      reason: `Homebrew is not known to run on ${name}`,
    };
  }
  if (!isAtLeast(release.versionId, minimum)) {
    return {
      supported: false,
      reason: `Homebrew's bottles need a newer glibc than ${name} has`,
    };
  }

  return { supported: true, prerequisites: HOMEBREW_PREREQUISITES };
}

/**
 * compares a dotted release number with a minimum, part by part
 * @param versionId the release, such as `22.04`
 * @param minimum the oldest release accepted, such as `22.04`
 * @returns true when the release is the minimum or newer
 */
function isAtLeast(versionId: string, minimum: string): boolean {
  const parts = versionId.split('.').map(Number);
  for (const [index, least] of minimum.split('.').map(Number).entries()) {
    const part = parts[index] ?? 0;
    if (Number.isNaN(part)) {
      return false;
    }
    if (part !== least) {
      return part > least;
    }
  }

  return true;
}
