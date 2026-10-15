import { posix } from 'node:path';

import { guestAsset, readAsset } from '#guest/assets';
import { AGENT_HOME } from '#guest/guest-root';
import { ROOT_ONLY_MODE } from '#os/contracts';

import { runGuest } from '../guest.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestRunResult } from './types.js';

/** a non-root guest account and the provider shell accounts it may be one of */
export interface NativeAccountOwner {
  /** account that owns the path */
  user: string;
  /** provider shell accounts core may manage besides the agent account */
  shellAccounts: readonly string[];
}

/** arguments for an operation confined to one native account home */
interface NativeFileCommandParams {
  guest: GuestChannel;
  path: string;
  operation: 'mkdir' | 'write' | 'remove';
  owner?: NativeAccountOwner;
  contents?: string;
}

export const USER = 'agent';

export const HOME = AGENT_HOME;

export const AGENT_PATH = `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
/** the program that changes one file in an account's home as that account, read from the package and run inline */
const HOME_FILES = guestAsset(
  'integrations/guest/home-files.sh',
  ROOT_ONLY_MODE,
);

/**
 * runs a command as the non-root guest account
 * @param argv executable and arguments
 * @returns the command behind runuser for the agent account
 */
export function asAgent(argv: readonly string[]): string[] {
  return ['/usr/sbin/runuser', '-u', USER, '--', ...argv];
}

/**
 * executes a native harness command as the non-root guest account
 * @param guest target guest
 * @param args executable and arguments
 * @returns guest process output
 */
export async function runAsAgent(
  guest: GuestChannel,
  args: string[],
): Promise<GuestRunResult> {
  return runGuest(
    guest,
    asAgent(['/usr/bin/env', `--chdir=${HOME}`, `PATH=${AGENT_PATH}`, ...args]),
  );
}

/**
 * ensures a non-root-owned private guest directory
 * @param guest target guest
 * @param path absolute directory path
 * @param owner provider shell account that owns the directory; the agent account when omitted
 */
export async function ensurePrivateDirectory(
  guest: GuestChannel,
  path: string,
  owner?: NativeAccountOwner,
): Promise<void> {
  await runNativeFileCommand({ guest, path, owner, operation: 'mkdir' });
}

/**
 * writes a private native configuration file owned by the guest account
 * @param guest target guest
 * @param path absolute file path
 * @param contents serialized native settings
 */
export async function writeOwnedFile(
  guest: GuestChannel,
  path: string,
  contents: string,
): Promise<void> {
  await runNativeFileCommand({ guest, path, operation: 'write', contents });
}

/**
 * removes native files as their non-root owner after refusing linked paths
 * @param guest target guest
 * @param path absolute native file path
 */
export async function removeOwnedFile(
  guest: GuestChannel,
  path: string,
): Promise<void> {
  await runNativeFileCommand({ guest, path, operation: 'remove' });
}

/**
 * runs the home files program as the native account, which refuses a linked
 * or foreign path below its home
 * @param params target account, operation and private stdin contents
 * @throws {Error} when the account or destination is outside the managed home
 */
async function runNativeFileCommand(
  params: NativeFileCommandParams,
): Promise<void> {
  const { guest, path, operation, owner, contents } = params;
  const user = owner?.user ?? USER;
  const home = `/home/${user}`;
  if (
    ![USER, ...(owner?.shellAccounts ?? [])].includes(user) ||
    !path.startsWith(`${home}/`) ||
    posix.normalize(path) !== path ||
    path.includes('\0')
  ) {
    throw new Error(
      'Native file path must remain inside its owning account home',
    );
  }
  await runGuest(
    guest,
    [
      '/usr/sbin/runuser',
      '-u',
      user,
      '--',
      '/bin/sh',
      '-c',
      await readAsset(HOME_FILES),
      'oa-home-files',
      operation,
      home,
      path,
    ],
    { input: contents, step: 'native home file update' },
  );
}
