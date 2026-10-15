import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { isRecord } from '../records.js';

import { AWAKE_FILE_MODE, removeFile } from './files.js';

import type { Stats } from 'node:fs';

// guest kernel: imports only Node built-ins and other guest code. A lock is a
// file created exclusively, holding a token only its creator knows. Root takes
// only its own lock, in the managed awake directory no other account writes,
// and the agent account takes its locks in the shared awake directory; so an
// agent process that plants, holds or keeps refreshing its lock only ever
// delays the agent account's own writers, never root's. A holder releases its
// lock within the governor's bounded work, so a lock older than that belongs
// to a killed writer and is broken, and so is a lock whose creator's process
// no longer exists, at once: one breaker at a time, under a guard file,
// moves the stale lock aside and removes it only after checking that what it
// moved is the lock it judged stale. Every attempt sleeps and honours the wait
// limit, so a lock that is not a regular file, or that cannot be removed, ends
// the wait with its reason instead of a busy loop

const RETRY_MS = 20;
const GUARD_SUFFIX = '.break';
const STALE_SUFFIX = '.stale-';
/** largest token a lock file holds, in bytes */
const TOKEN_MAX_BYTES = 128;
/** every lock and guard file the governor keeps in an awake directory */
const LOCK_FILE = /^\.(?:apply\.)?lock(?:\.break)?$/;

/** the state lock's name within an awake directory */
export const STATE_LOCK = '.lock';

/** the apply lock's name within the shared awake directory */
export const APPLY_LOCK = '.apply.lock';

/** how long a caller waits for the lock and when a held lock counts as abandoned */
export interface AwakeLockTiming {
  /** longest wait before the caller gives up */
  waitMs: number;
  /** age after which a held lock belongs to a killed writer */
  staleMs: number;
}

/** the default lock timing; a holder's bounded work is far below the stale age */
const AWAKE_LOCK_TIMING: AwakeLockTiming = {
  waitMs: 3_000,
  staleMs: 15_000,
};

/** the lock file this writer created */
interface HeldLock {
  /** the lock file's inode */
  inode: number;
  /** the token written into it */
  token: string;
}

/**
 * tells whether a directory entry is one of the governor's lock files, which
 * a scan neither reads as a holder nor removes as foreign
 * @param name entry name within an awake directory
 * @returns true for a lock or its break guard
 */
export function isLockFile(name: string): boolean {
  return LOCK_FILE.test(name);
}

/**
 * runs an action while holding a lock
 * @param path absolute lock file path
 * @param action work done under the lock
 * @param timing wait limit and stale age
 * @returns the action's result
 * @throws {Error} when the lock is not acquired within the wait limit, naming
 * why when the lock is not a regular file or cannot be removed
 */
export async function withAwakeLock<T>(
  path: string,
  action: () => Promise<T>,
  timing: AwakeLockTiming = AWAKE_LOCK_TIMING,
): Promise<T> {
  const held = await acquire(path, timing);
  try {
    return await action();
  } finally {
    await release(path, held);
  }
}

/**
 * creates the lock file exclusively, breaking an abandoned one; every attempt
 * sleeps and checks the wait limit
 * @param path absolute lock file path
 * @param timing wait limit and stale age
 * @returns the created lock file
 * @throws {Error} when the lock is not acquired within the wait limit
 */
async function acquire(
  path: string,
  timing: AwakeLockTiming,
): Promise<HeldLock> {
  const giveUpAt = Date.now() + timing.waitMs;
  for (;;) {
    const held = await create(path);
    if (held) {
      return held;
    }
    const blocked = await breakIfStale(path, timing.staleMs);
    if (Date.now() >= giveUpAt) {
      throw new Error(
        `The awake lock ${blocked ?? 'is held by another writer'}`,
      );
    }
    await sleep(RETRY_MS);
  }
}

/**
 * creates the lock file, unless one exists
 * @param path absolute lock file path
 * @returns the created lock, or undefined when another lock exists
 * @throws {Error} when the lock cannot be created for another reason
 */
async function create(path: string): Promise<HeldLock | undefined> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    AWAKE_FILE_MODE,
  ).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return undefined;
  }
  const token = `${process.pid} ${randomUUID()}`;
  try {
    await handle.writeFile(token);

    return { inode: (await handle.stat()).ino, token };
  } catch (error) {
    await removeFile(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * breaks the lock when it is older than the stale age
 * @param path absolute lock file path
 * @param staleMs age after which a held lock belongs to a killed writer
 * @returns why the lock can never be acquired, when it is not a regular file
 * or cannot be removed; undefined otherwise
 */
async function breakIfStale(
  path: string,
  staleMs: number,
): Promise<string | undefined> {
  const held = await lstat(path).catch(() => undefined);
  if (!held) {
    return undefined;
  }
  if (!held.isFile()) {
    return 'is not a regular file';
  }

  return (await isAbandoned(path, held, staleMs))
    ? breakStale(path, staleMs)
    : undefined;
}

/**
 * tells whether a lock belongs to a killed writer: it is older than the stale
 * age, or the process that created it no longer exists, which frees a lock a
 * killed apply left without waiting out the stale age
 * @param path absolute lock file path
 * @param info the lock's status
 * @param staleMs age after which a held lock belongs to a killed writer
 * @returns true when no live writer holds the lock
 */
async function isAbandoned(
  path: string,
  info: Stats,
  staleMs: number,
): Promise<boolean> {
  if (Date.now() - info.mtimeMs > staleMs) {
    return true;
  }
  const pid = await creatorOf(path, info);

  return pid !== undefined && !isAlive(pid);
}

/**
 * reads the process id a lock's token starts with
 * @param path absolute lock file path
 * @param info the lock's status, which the file read must still match
 * @returns the creator's process id, or undefined when the token is missing
 * or is not the one this module writes
 */
async function creatorOf(
  path: string,
  info: Stats,
): Promise<number | undefined> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (!handle) {
    return undefined;
  }
  try {
    if ((await handle.stat()).ino !== info.ino) {
      return undefined;
    }
    const buffer = Buffer.alloc(TOKEN_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /^(\d+) /u.exec(buffer.subarray(0, bytesRead).toString());

    return match?.[1] ? Number(match[1]) : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * tells whether a process exists; one the caller may not signal still exists
 * @param pid process id
 * @returns false only when no such process exists
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !(isRecord(error) && error.code === 'ESRCH');
  }
}

/**
 * breaks a stale lock under the break guard, so no two writers break it and
 * no writer removes a lock created after it judged the old one stale
 * @param path absolute lock file path
 * @param staleMs age after which a held lock or guard is abandoned
 * @returns why the lock cannot be removed; undefined when it was removed or
 * another writer is breaking it
 */
async function breakStale(
  path: string,
  staleMs: number,
): Promise<string | undefined> {
  const guard = `${path}${GUARD_SUFFIX}`;
  const guarded = await create(guard).catch(() => 'refused' as const);
  if (guarded === 'refused') {
    return 'cannot be removed';
  }
  if (!guarded) {
    // a guard as old as a stale lock belongs to a breaker that was killed
    const left = await lstat(guard).catch(() => undefined);
    if (left?.isFile() && Date.now() - left.mtimeMs > staleMs) {
      await removeFile(guard).catch(() => undefined);
    }

    return undefined;
  }
  try {
    // judged again under the guard: a lock created since is not stale
    const stale = await lstat(path).catch(() => undefined);
    if (!stale?.isFile() || !(await isAbandoned(path, stale, staleMs))) {
      return undefined;
    }

    return await moveAside(path, stale);
  } finally {
    await release(guard, guarded);
  }
}

/**
 * moves a stale lock to a unique name and removes it there only when it is
 * the lock judged stale, putting back any other lock it moved
 * @param path absolute lock file path
 * @param stale the lock's status when it was judged stale
 * @returns why the lock cannot be removed; undefined when it was removed
 */
async function moveAside(
  path: string,
  stale: Stats,
): Promise<string | undefined> {
  const moved = `${path}${STALE_SUFFIX}${randomUUID()}`;
  const outcome = await rename(path, moved).then(
    () => 'moved' as const,
    (error: unknown) =>
      isRecord(error) && error.code === 'ENOENT'
        ? ('gone' as const)
        : ('refused' as const),
  );
  if (outcome !== 'moved') {
    return outcome === 'refused' ? 'cannot be removed' : undefined;
  }
  const info = await lstat(moved).catch(() => undefined);
  if (info?.ino === stale.ino && info.mtimeMs === stale.mtimeMs) {
    return removeFile(moved).then(
      () => undefined,
      () => 'cannot be removed',
    );
  }
  // a writer created a lock between the judgement and the move: put it back
  // without replacing any lock created since, then drop the extra name
  await link(moved, path).catch(() => undefined);
  await removeFile(moved).catch(() => undefined);

  return undefined;
}

/**
 * removes the lock only while it is still the one this writer created: the
 * same inode holding the same token
 * @param path absolute lock file path
 * @param held the lock this writer created
 */
async function release(path: string, held: HeldLock): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (!handle) {
    return;
  }
  let isOwn = false;
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(TOKEN_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    isOwn =
      info.isFile() &&
      info.ino === held.inode &&
      buffer.subarray(0, bytesRead).toString() === held.token;
  } finally {
    await handle.close();
  }
  if (isOwn) {
    await removeFile(path).catch(() => undefined);
  }
}
