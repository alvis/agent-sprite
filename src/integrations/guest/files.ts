import { posix } from 'node:path';

import { runBoundedIO } from '#operation';

import {
  currentGuestTransaction,
  withGuestTransaction,
} from './transaction.js';

import type { Sprite } from '@fly/sprites';

import type { GuestFileParams } from './types.js';

/**
 * writes a guest file atomically with an explicit mode
 * @param sprite target Sprite
 * @param params destination, contents, and optional permissions
 */
export async function writeGuestFile(
  sprite: Sprite,
  params: GuestFileParams,
): Promise<void> {
  assertRootFilePath(params.path);
  if (params.removeOnRelease && !currentGuestTransaction(sprite)) {
    throw new Error('Transient guest files require an active transaction');
  }
  await withGuestTransaction(sprite, async () => {
    await currentGuestTransaction(sprite)!.write(params);
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
 * @param sprite target Sprite
 * @param path absolute guest file path
 * @returns requested file contents
 */
export async function readGuestFile(
  sprite: Sprite,
  path: string,
): Promise<string> {
  const transaction = currentGuestTransaction(sprite);
  if (transaction) {
    return transaction.read(path);
  }

  return runBoundedIO(async () => sprite.filesystem().readFile(path, 'utf8'));
}

/**
 * checks guest existence through the current filesystem transaction when present
 * @param sprite exact target guest
 * @param path absolute guest path
 * @returns whether the path exists
 */
export async function guestFileExists(
  sprite: Sprite,
  path: string,
): Promise<boolean> {
  const transaction = currentGuestTransaction(sprite);

  return transaction
    ? transaction.exists(path)
    : runBoundedIO(async () => sprite.filesystem().exists(path));
}

/**
 * changes root-path ownership through its protected guest executor
 * @param sprite exact target guest
 * @param path root-controlled guest path
 * @param owner target numeric user and group IDs
 * @param owner.uid target numeric user ID
 * @param owner.gid target numeric group ID
 */
export async function chownGuestFile(
  sprite: Sprite,
  path: string,
  owner: { uid: number; gid: number },
): Promise<void> {
  assertRootFilePath(path);
  await withGuestTransaction(sprite, async () => {
    await currentGuestTransaction(sprite)!.chown(path, owner.uid, owner.gid);
  });
}

/**
 * removes a root-controlled file through its protected guest executor
 * @param sprite exact target guest
 * @param path root-controlled guest path
 */
export async function removeGuestFile(
  sprite: Sprite,
  path: string,
): Promise<void> {
  assertRootFilePath(path);
  await withGuestTransaction(sprite, async () => {
    await currentGuestTransaction(sprite)!.remove(path);
  });
}
