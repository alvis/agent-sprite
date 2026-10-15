import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOMEBREW } from '../homebrew.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';

/** how a program runs as the account that owns the Homebrew prefix */
export type RunAsHomebrew = (
  program: string,
  args: readonly string[],
  capture?: boolean,
) => Promise<string>;

/** the Homebrew paths an installer works with, as `HOMEBREW` sets them */
export interface HomebrewLayout {
  /** the account that owns the prefix */
  account: string;
  /** the account's home */
  home: string;
  /** the prefix */
  prefix: string;
  /** the brew command */
  brew: string;
}

/** the bottle platforms a workstation pours */
export type BottleTag = 'arm64_linux' | 'x86_64_linux';

/** Homebrew on Linux as one install run uses it */
export interface Homebrew {
  /** the Homebrew paths this run uses */
  layout: HomebrewLayout;
  /** the bottle platform of this workstation */
  bottle: BottleTag;
  /** installs Homebrew when it is absent, otherwise updates its formulae; does either at most once per run */
  ready: () => Promise<void>;
  /** runs brew as the prefix's account, returning its output when captured */
  run: (args: readonly string[], capture?: boolean) => Promise<string>;
  /** whether a formula is installed in the prefix, by the name Homebrew gives it */
  has: (formula: string) => Promise<boolean>;
  /** the names of the entries a directory holds */
  entries: (directory: string) => Promise<string[]>;
  /** whether a path resolves to a file inside the prefix */
  owns: (path: string) => Promise<boolean>;
}

const SHARED_DIRECTORY_MODE = 0o755;
const SHARED_FILE_MODE = 0o644;
const NOLOGIN = '/usr/sbin/nologin';
// the highest user id Debian and Ubuntu hand a system account
const SYSTEM_UID_MAX = 999;
// groups whose members may become root through sudo
const ADMIN_GROUPS = new Set(['sudo', 'admin', 'wheel', 'root']);
const HOME_REFUSAL =
  'The Homebrew home belongs to another account; refusing to run brew in it';

/** the name the installer's private directory starts with */
export const HOMEBREW_INSTALLER_DIRECTORY = 'open-agent-homebrew-';

/** where the installer is read from, and the digest it must have */
export interface HomebrewInstaller {
  /** the installer script's address */
  url: string;
  /** the script's SHA-256, in hex */
  sha256: string;
}

/** the official installer, pinned to one commit of Homebrew/install and checked against its digest */
export const HOMEBREW_INSTALLER: HomebrewInstaller = {
  url: 'https://raw.githubusercontent.com/Homebrew/install/7a3f48c7e498d7df3237fd41c30f4d492857edf4/install.sh',
  sha256: '5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148',
};

/** what Homebrew is installed with */
interface Source {
  /** the installer's root runner and release reader */
  tools: Pick<ReleaseInstallTools, 'run' | 'downloadText'>;
  /** runs a program as the prefix's account */
  runAsHomebrew: RunAsHomebrew;
  /** the Homebrew paths */
  layout: HomebrewLayout;
  /** the pinned installer */
  installer: HomebrewInstaller;
  /** the highest user id the account may have */
  systemUidMax: number;
}

/**
 * prepares Homebrew for one install run: its account, its prefix, and either
 * the pinned installer or one formula update
 * @param tools the installer's root runner and release reader
 * @param runAsHomebrew runs a program as the prefix's account
 * @param overrides another layout, installer or user id range than the
 * workstation's, for a proof run by an ordinary user
 * @returns Homebrew for this run
 */
export function homebrew(
  tools: Source['tools'],
  runAsHomebrew: RunAsHomebrew,
  overrides: Partial<
    Pick<Source, 'layout' | 'installer' | 'systemUidMax'>
  > = {},
): Homebrew {
  const {
    layout = HOMEBREW,
    installer = HOMEBREW_INSTALLER,
    systemUidMax = SYSTEM_UID_MAX,
  } = overrides;
  let readying: Promise<void> | undefined;

  return {
    layout,
    bottle: process.arch === 'arm64' ? 'arm64_linux' : 'x86_64_linux',
    ready: async () => {
      readying ??= prepare({
        tools,
        runAsHomebrew,
        layout,
        installer,
        systemUidMax,
      });

      return readying;
    },
    run: async (args, capture) => runAsHomebrew(layout.brew, args, capture),
    has: async (formula) => exists(`${layout.prefix}/opt/${formula}`),
    entries: async (directory) => readdir(directory),
    // the prefix is resolved too, since a provider may link the account's home onto a volume
    owns: async (path) => {
      try {
        const [target, root] = await Promise.all([
          realpath(path),
          realpath(layout.prefix),
        ]);

        return target.startsWith(`${root}/`);
      } catch {
        return false;
      }
    },
  };
}

/**
 * makes sure the account owns its home, then updates the formulae of an
 * installed Homebrew or creates the prefix and installs Homebrew into it
 * @param source what Homebrew is installed with
 * @throws {Error} when the account is unfit, the home or an installed prefix
 * belongs to another account, or the installer differs from its pin
 */
async function prepare(source: Source): Promise<void> {
  const { tools, runAsHomebrew, layout, installer } = source;
  const { account, home, prefix, brew } = layout;
  const ensured = await ensureAccount(source);
  await assertHomeOwned(source, ensured);
  if (await exists(brew)) {
    // root never hands brew a prefix some other account or group could have
    // changed, since the installer makes the prefix writable by its group
    if (!isOwnedBy(await stat(prefix), ensured)) {
      throw new Error(
        'The Homebrew prefix belongs to another account; refusing to run it',
      );
    }
    await runAsHomebrew(brew, ['update']);

    return;
  }
  await tools.run('/usr/bin/install', [
    '-d',
    '-o',
    account,
    '-g',
    account,
    '-m',
    '0755',
    home,
    prefix,
  ]);
  // the installer clones Homebrew and updates its formulae itself
  const script = await tools.downloadText(installer.url);
  // the digest covers exactly the text written below, so the script that runs
  // is the pinned one
  const digest = createHash('sha256').update(script).digest('hex');
  if (digest !== installer.sha256) {
    throw new Error('Homebrew installer digest does not match its pin');
  }
  // root-owned, so the account reads the script but cannot change it
  const directory = await mkdtemp(join(tmpdir(), HOMEBREW_INSTALLER_DIRECTORY));
  try {
    await chmod(directory, SHARED_DIRECTORY_MODE);
    const file = join(directory, 'install.sh');
    await writeFile(file, script, { mode: SHARED_FILE_MODE, flag: 'wx' });
    await runAsHomebrew('/bin/bash', [file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** an account as the password database lists it */
interface Account {
  /** the account's user id */
  uid: number;
  /** the account's group id */
  gid: number;
  /** the account's home */
  home: string;
  /** the account's shell */
  shell: string;
}

/**
 * makes sure the prefix's account exists as a system account with no login
 * shell, a locked password and no administrative group, checking an existing
 * account before changing it
 * @param source what Homebrew is installed with
 * @returns the user and group ids, home and shell the account has once ensured
 * @throws {Error} when the account cannot be created, is not a system account
 * or belongs to a group that may use sudo
 */
async function ensureAccount(source: Source): Promise<Account> {
  const { tools, layout, systemUidMax } = source;
  const { account, home } = layout;
  const existing = await readAccount(tools, account);
  const ensured = existing ?? (await createAccount(source));
  if (ensured.uid === 0 || ensured.uid > systemUidMax) {
    throw new Error('The Homebrew account is not a system account');
  }
  const groups = (await tools.run('/usr/bin/id', ['-nG', account], true))
    .trim()
    .split(/\s+/u);
  if (groups.some((group) => ADMIN_GROUPS.has(group))) {
    throw new Error('The Homebrew account may use sudo; refusing to run it');
  }
  if (ensured.shell !== NOLOGIN || ensured.home !== home) {
    await tools.run('/usr/sbin/usermod', [
      '--home',
      home,
      '--shell',
      NOLOGIN,
      '--lock',
      account,
    ]);
  }

  return ensured;
}

/**
 * creates the prefix's account as a system account with no login shell and
 * no password, joining a group of its name left without it. A home that
 * survived a cold boot which lost the password database keeps the user and
 * group ids it was made under, so the account and its group are recreated
 * under those ids and no file has to change owner
 * @param source what Homebrew is installed with
 * @returns the new account as the password database lists it
 * @throws {Error} when a surviving home's ids cannot be taken back or the
 * account cannot be read back
 */
async function createAccount(source: Source): Promise<Account> {
  const { tools, layout } = source;
  const { account, home } = layout;
  const group = await listed(tools, 'group', account);
  const survivor = (await exists(home)) ? await stat(home) : undefined;
  const reclaims = survivor !== undefined && survivor.uid !== 0;
  if (reclaims) {
    await reclaimIds(source, survivor, group);
  }
  await tools.run('/usr/sbin/useradd', [
    '--system',
    ...(reclaims ? ['--uid', String(survivor.uid)] : []),
    ...(reclaims || group !== undefined
      ? ['--gid', account]
      : ['--user-group']),
    '--home-dir',
    home,
    '--no-create-home',
    '--shell',
    NOLOGIN,
    account,
  ]);
  const created = await readAccount(tools, account);
  if (!created) {
    throw new Error('The Homebrew account could not be created');
  }

  return created;
}

/**
 * checks that the ids a surviving home was made under are free system ids the
 * account can take back, recreating the account's group under the home's
 * group id when the group was lost with the account. Debian and Ubuntu hand
 * out system group ids from the same range as system user ids
 * @param source what Homebrew is installed with
 * @param survivor the surviving home's owner and group
 * @param survivor.uid the home's user id
 * @param survivor.gid the home's group id
 * @param group the group database's entry for the account's group, if any
 * @throws {Error} when another account or group holds an id, or an id is not
 * a system id
 */
async function reclaimIds(
  source: Source,
  survivor: { uid: number; gid: number },
  group: string | undefined,
): Promise<void> {
  const { tools, layout, systemUidMax } = source;
  const isSystemId = (id: number): boolean => id > 0 && id <= systemUidMax;
  const isFree = async (database: string, id: number): Promise<boolean> =>
    (await listed(tools, database, String(id))) === undefined;
  const userFree =
    isSystemId(survivor.uid) && (await isFree('passwd', survivor.uid));
  const groupFits =
    group === undefined
      ? isSystemId(survivor.gid) && (await isFree('group', survivor.gid))
      : group.trim().split(':')[2] === String(survivor.gid);
  if (!userFree || !groupFits) {
    throw new Error(HOME_REFUSAL);
  }
  if (group === undefined) {
    await tools.run('/usr/sbin/groupadd', [
      '--system',
      '--gid',
      String(survivor.gid),
      layout.account,
    ]);
  }
}

/**
 * refuses a surviving home the account and its group do not own, so brew
 * never runs where another account or group could have changed what it runs.
 * A home root owns outright that holds no Homebrew yet, as a provider
 * prepares one on its volume, is the one exception: the install hands that
 * directory to the account itself
 * @param source what Homebrew is installed with
 * @param account the account's user and group ids
 * @throws {Error} when the home belongs to another account or group
 */
async function assertHomeOwned(
  source: Source,
  account: Pick<Account, 'uid' | 'gid'>,
): Promise<void> {
  const { home, brew } = source.layout;
  if (!(await exists(home))) {
    return;
  }
  const owner = await stat(home);
  const isRootOwned = owner.uid === 0 && owner.gid === 0;
  if (!isOwnedBy(owner, account) && (!isRootOwned || (await exists(brew)))) {
    throw new Error(HOME_REFUSAL);
  }
}

/**
 * tells whether a file belongs to an account and its group
 * @param file the file's owner and group
 * @param file.uid the file's user id
 * @param file.gid the file's group id
 * @param account the account's user and group ids
 * @returns whether both ids match
 */
function isOwnedBy(
  file: { uid: number; gid: number },
  account: Pick<Account, 'uid' | 'gid'>,
): boolean {
  return file.uid === account.uid && file.gid === account.gid;
}

/**
 * looks a key up in a system database
 * @param tools the installer's root runner
 * @param database the database, such as `passwd` or `group`
 * @param key a name or id
 * @returns the entry, or nothing when the database does not list the key
 */
async function listed(
  tools: Source['tools'],
  database: string,
  key: string,
): Promise<string | undefined> {
  return tools
    .run('/usr/bin/getent', [database, key], true)
    .catch(() => undefined);
}

/**
 * reads an account from the password database
 * @param tools the installer's root runner
 * @param account the account's name
 * @returns the account, or nothing when the database does not list it
 * @throws {Error} when the database lists the account without a user or
 * group id
 */
async function readAccount(
  tools: Source['tools'],
  account: string,
): Promise<Account | undefined> {
  const entry = await listed(tools, 'passwd', account);
  if (entry === undefined) {
    return undefined;
  }
  const [, , uid = '', gid = '', , home = '', shell = ''] = entry
    .trim()
    .split(':');
  if (!/^\d+$/u.test(uid) || !/^\d+$/u.test(gid)) {
    throw new Error('The Homebrew account has no valid user or group id');
  }

  return { uid: Number(uid), gid: Number(gid), home, shell };
}

/**
 * tells whether a path exists, following links
 * @param path absolute path
 * @returns whether it exists
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}
