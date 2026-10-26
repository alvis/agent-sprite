import { posix } from 'node:path';

import { readAsset } from '#adapters/guest/platform/assets';
import {
  AGENT_HOME,
  AGENT_PATH,
  accountHome,
} from '#adapters/guest/platform/layout';

import { contentsInput } from './files';
import { runGuest } from './run';

import type { GuestChannel } from '#application/ports/guest-channel';
import type { GuestAsset } from '#domain/guest';

import type { GuestRunResult } from './run';

/** a non-root guest account and the provider shell accounts it may be one of */
export interface NativeAccountOwner {
  /** account that owns the path */
  user: string;
  /** provider shell accounts core may manage besides the agent account */
  shellAccounts: readonly string[];
}

/** a file written into an account's home */
export interface AccountFile {
  /** absolute path inside the owning account's home */
  path: string;
  /** the file's complete contents */
  contents: string;
}

/** arguments for an operation confined to one native account home */
interface NativeFileCommandParams {
  guest: GuestChannel;
  path: string;
  operation: 'mkdir' | 'write' | 'remove';
  owner?: NativeAccountOwner;
  contents?: string;
}

/** account used for the agent's native guest commands */
export const USER = 'agent';

/** home directory of the agent's native guest account */
export const HOME = AGENT_HOME;

/** the program that changes one file in an account's home as that account, read from the package and run inline */
const HOME_FILES: Pick<GuestAsset, 'path'> = {
  path: 'accounts/home-files.sh',
};

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
 * writes a private native configuration file owned by the guest account;
 * contents that hold a credential, such as a gateway key, go as a secret input
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
 * writes a private file owned by the agent or a provider shell account;
 * contents that hold a credential go as a secret input
 * @param guest target guest
 * @param owner account that owns the file
 * @param file absolute path inside the owner's home and its contents
 */
export async function writeAccountFile(
  guest: GuestChannel,
  owner: NativeAccountOwner,
  file: AccountFile,
): Promise<void> {
  await runNativeFileCommand({ guest, owner, operation: 'write', ...file });
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
  const home = accountHome(user);
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
    {
      ...(contents === undefined ? {} : contentsInput(contents)),
      step: 'native home file update',
    },
  );
}
