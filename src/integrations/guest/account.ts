import { posix } from 'node:path';

import { CommandFault } from '#errors';
import { runOperation } from '#operation';

import { assertRootFilePath, chownGuestFile, runGuest } from '../guest.js';

import { deployGuestPayload } from './payloads.js';

import type { Sprite } from '@fly/sprites';

import type { GuestRunResult } from './types.js';

/** arguments for an operation confined to one native account home */
interface NativeFileCommandParams {
  sprite: Sprite;
  path: string;
  operation: 'mkdir' | 'write' | 'remove';
  user?: string;
  contents?: string;
}

export const USER = 'agent';

export const HOME = '/home/agent';

export const AGENT_PATH = `${HOME}/.local/bin:/opt/agent-sprite/node/bin:/usr/local/bin:/usr/bin:/bin`;
const NATIVE_FILES_PATH = '/opt/agent-sprite/native-files.js';
const NATIVE_FILES_MODE = 0o755;

/**
 * executes a native harness command as the non-root guest account
 * @param sprite target guest
 * @param args executable and arguments
 * @returns guest process output
 */
export async function runAsAgent(
  sprite: Sprite,
  args: string[],
): Promise<GuestRunResult> {
  return runGuest(sprite, [
    '/usr/sbin/runuser',
    '-u',
    USER,
    '--',
    '/usr/bin/env',
    `--chdir=${HOME}`,
    `PATH=${AGENT_PATH}`,
    ...args,
  ]);
}

/**
 * ensures a non-root-owned private guest directory
 * @param sprite target guest
 * @param path absolute directory path
 * @param user non-root guest account that owns the directory
 */
export async function ensurePrivateDirectory(
  sprite: Sprite,
  path: string,
  user = USER,
): Promise<void> {
  await runNativeFileCommand({ sprite, path, user, operation: 'mkdir' });
}

/**
 * writes a private native configuration file owned by the guest account
 * @param sprite target guest
 * @param path absolute file path
 * @param contents serialized native settings
 */
export async function writeOwnedFile(
  sprite: Sprite,
  path: string,
  contents: string,
): Promise<void> {
  await runNativeFileCommand({ sprite, path, operation: 'write', contents });
}

/**
 * removes native files as their non-root owner after refusing linked paths
 * @param sprite target guest
 * @param path absolute native file path
 */
export async function removeOwnedFile(
  sprite: Sprite,
  path: string,
): Promise<void> {
  await runNativeFileCommand({ sprite, path, operation: 'remove' });
}

/**
 * transfers ownership using IDs resolved inside the guest instead of provider usernames
 * @param sprite managed guest with its non-root accounts installed
 * @param path managed file or directory to transfer
 * @param account non-root guest account that owns the path
 */
export async function ownGuestFile(
  sprite: Sprite,
  path: string,
  account = USER,
): Promise<void> {
  assertRootFilePath(path);
  const [user, group] = await runOperation(async () =>
    Promise.all([
      runGuest(sprite, ['/usr/bin/id', '-u', account]),
      runGuest(sprite, ['/usr/bin/id', '-g', account]),
    ]),
  );
  const uid = Number(user.stdout.trim());
  const gid = Number(group.stdout.trim());
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0
  ) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: `Guest ${account} account did not resolve to non-root numeric IDs`,
    });
  }
  await chownGuestFile(sprite, path, { uid, gid });
}

/**
 * deploys the current file helper and invokes it as the native account
 * @param params target account, operation and private stdin contents
 * @throws {Error} when the account or destination is outside the managed home
 */
async function runNativeFileCommand(
  params: NativeFileCommandParams,
): Promise<void> {
  const { sprite, path, operation, user = USER, contents } = params;
  const home = `/home/${user}`;
  if (
    !['agent', 'sprite'].includes(user) ||
    !path.startsWith(`${home}/`) ||
    posix.normalize(path) !== path ||
    path.includes('\0')
  ) {
    throw new Error(
      'Native file path must remain inside its owning account home',
    );
  }
  await deployGuestPayload(sprite, 'native-files.js', NATIVE_FILES_MODE);
  await runGuest(
    sprite,
    [
      '/usr/sbin/runuser',
      '-u',
      user,
      '--',
      '/opt/agent-sprite/node/bin/node',
      NATIVE_FILES_PATH,
      operation,
      home,
      path,
    ],
    { input: contents, step: 'native home file update' },
  );
}
