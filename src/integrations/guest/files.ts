import { posix } from 'node:path';

import { runBoundedIO } from '#operation';

import {
  currentGuestTransaction,
  withGuestTransaction,
} from './transaction.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestFileParams } from './types.js';

/**
 * writes a guest file atomically with an explicit mode
 * @param guest target guest
 * @param params destination, contents, and optional permissions
 */
export async function writeGuestFile(
  guest: GuestChannel,
  params: GuestFileParams,
): Promise<void> {
  assertRootFilePath(params.path);
  if (params.removeOnRelease && !currentGuestTransaction(guest)) {
    throw new Error('Transient guest files require an active transaction');
  }
  await withGuestTransaction(guest, async () => {
    await currentGuestTransaction(guest)!.write(params);
  });
}

/**
 * keeps root filesystem mutations outside native account homes
 * @param path requested guest file path
 * @throws {Error} when a path could bypass the native account write boundary
 */
export function assertRootFilePath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    !posix.isAbsolute(path) ||
    normalized !== path ||
    normalized === '/home' ||
    normalized.startsWith('/home/') ||
    path.includes('\0')
  ) {
    throw new Error('Guest home files must be changed as their owning account');
  }
}

/**
 * reads an explicitly requested guest file
 * @param guest target guest
 * @param path absolute guest file path
 * @returns requested file contents
 */
export async function readGuestFile(
  guest: GuestChannel,
  path: string,
): Promise<string> {
  const transaction = currentGuestTransaction(guest);
  if (transaction) {
    return transaction.read(path);
  }

  return runBoundedIO(async () => guest.read(path));
}

/**
 * checks guest existence through the current filesystem transaction when present
 * @param guest exact target guest
 * @param path absolute guest path
 * @returns whether the path exists
 */
export async function guestFileExists(
  guest: GuestChannel,
  path: string,
): Promise<boolean> {
  const transaction = currentGuestTransaction(guest);

  return transaction
    ? transaction.exists(path)
    : runBoundedIO(async () => guest.exists(path));
}

/**
 * removes a root-controlled file through its protected guest executor
 * @param guest exact target guest
 * @param path root-controlled guest path
 */
export async function removeGuestFile(
  guest: GuestChannel,
  path: string,
): Promise<void> {
  assertRootFilePath(path);
  await withGuestTransaction(guest, async () => {
    await currentGuestTransaction(guest)!.remove(path);
  });
}
