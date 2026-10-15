import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '../records.js';

// guest kernel: imports only Node built-ins and other guest code. The shared
// awake directory is writable by the agent account, so every file in it is
// untrusted data to every reader, root included: it is opened without
// following links, must be a single-link regular file of an accepted owner
// within a size bound, and is only ever parsed as JSON, never imported or
// executed

/**
 * mode of every file the governor writes: its owner writes it and the group of
 * its directory, the agent group, reads it, so root and the agent account read
 * each other's files and no one else reads any
 */
export const AWAKE_FILE_MODE = 0o640;
/** how long a temporary file may exist before a later writer prunes it as abandoned */
const ABANDONED_TEMPORARY_MS = 60_000;
/** the prefix of a temporary file a writer renames into place */
export const TEMPORARY_PREFIX = '.tmp-';

/** accounts whose files in the awake directory a reader accepts */
export interface UntrustedFileBounds {
  /** user ids that may own a file the reader accepts */
  owners: ReadonlySet<number>;
  /** largest file the reader accepts, in bytes */
  maxBytes: number;
}

/** why an untrusted file was refused, or its decoded contents */
export type UntrustedRead =
  | {
      /** the decoded JSON value, still to be validated */
      value: unknown;
    }
  | {
      /** non-secret reason the file was refused */
      refused: string;
    }
  | {
      /** the file does not exist */
      missing: true;
    };

/**
 * reads one JSON file from an agent-writable directory as untrusted data
 * @param path absolute file path
 * @param bounds accepted owners and size limit
 * @returns the decoded value, the refusal reason, or that the file is missing
 */
export async function readUntrustedJson(
  path: string,
  bounds: UntrustedFileBounds,
): Promise<UntrustedRead> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return 'missing' as const;
    }

    // ELOOP is a symbolic link; anything else is unreadable all the same
    return 'refused' as const;
  });
  if (handle === 'missing') {
    return { missing: true };
  }
  if (handle === 'refused') {
    return { refused: 'not a readable regular file' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      return { refused: 'not a single-link regular file' };
    }
    if (!bounds.owners.has(info.uid)) {
      return { refused: 'owned by a foreign account' };
    }
    if (info.size > bounds.maxBytes) {
      return { refused: 'larger than its size bound' };
    }
    const buffer = Buffer.alloc(bounds.maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > bounds.maxBytes) {
      return { refused: 'larger than its size bound' };
    }
    try {
      return { value: JSON.parse(buffer.subarray(0, bytesRead).toString()) };
    } catch {
      return { refused: 'not valid JSON' };
    }
  } finally {
    await handle.close();
  }
}

/**
 * replaces one file in a directory atomically: the contents go to a fresh
 * temporary file that no link can redirect, which takes the group of the
 * set-group-id directory, then rename over the name
 * @param directory absolute directory path
 * @param name file name within the directory
 * @param contents complete file contents
 */
export async function writeAtomically(
  directory: string,
  name: string,
  contents: string,
): Promise<void> {
  const temporary = join(directory, `${TEMPORARY_PREFIX}${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    AWAKE_FILE_MODE,
  );
  try {
    try {
      // the umask of a caller would otherwise hide the file from the group
      await handle.chmod(AWAKE_FILE_MODE);
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * removes a file by name; a file another writer already removed is no failure
 * @param path absolute file path
 */
export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== 'ENOENT') {
      throw error;
    }
  });
}

/**
 * removes temporary files a writer killed mid-write left behind
 * @param directory absolute directory path
 * @param names names of temporary files already listed
 * @param now current epoch milliseconds
 */
export async function pruneAbandonedTemporaries(
  directory: string,
  names: readonly string[],
  now: number,
): Promise<void> {
  for (const name of names) {
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > ABANDONED_TEMPORARY_MS) {
      await removeFile(path).catch(() => undefined);
    }
  }
}
