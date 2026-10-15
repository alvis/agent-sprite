import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isHolderProcess } from '../idle/process-identity.js';
import { isRecord } from '../records.js';

import { isSupervisedService } from './protocol.js';

import type { HolderProcess } from '../idle/process-identity.js';

import type { SupervisedService } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code. The desired
// services live on the persistent guest root, so a cold boot restores them;
// the running children live in the run directory, which a cold boot empties.
// Both directories belong to the supervisor's account and no other account
// can read or write them

/** mode of the supervisor's directories: its account alone enters them */
export const PRIVATE_DIRECTORY_MODE = 0o700;
/** mode of the supervisor's records: its account alone reads them */
export const PRIVATE_FILE_MODE = 0o600;
/** the desired services' record in the state directory */
export const DESIRED_FILE = 'services.json';
/** the running children's record in the run directory */
export const CHILDREN_FILE = 'children.json';
/** the services' output logs in the state directory */
export const LOGS_DIRECTORY = 'logs';

/** the largest record the supervisor reads */
const RECORD_LIMIT_BYTES = 262_144;
const RECORD_VERSION = 1;
/** group and other permission bits */
const SHARED_BITS = 0o077;

/** what the supervisor keeps running or stopped */
export type DesiredStatus = 'running' | 'stopped';

/** one registered service and whether it should run */
export interface DesiredService {
  /** the registered definition */
  definition: SupervisedService;
  /** whether the supervisor keeps it running */
  desired: DesiredStatus;
}

/** one child the supervisor started, so a restarted supervisor can end it */
export interface ChildRecord extends HolderProcess {
  /** service the child runs */
  name: string;
}

/** a decoded record and the entries it refused */
export interface RecordRead<T> {
  /** the valid entries, in recorded order */
  entries: T[];
  /** non-secret notes on what was refused */
  refused: string[];
}

/**
 * creates a directory only the supervisor's account enters, or checks an
 * existing one belongs to that account and tightens its mode
 * @param path absolute directory path
 * @throws {Error} when the path is not a directory the account owns
 */
export async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error(`${path} is not a directory the supervisor owns`);
  }
  if ((info.mode & SHARED_BITS) !== 0) {
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }
}

/**
 * reads the desired services, keeping each valid entry and noting the rest
 * @param directory the state directory
 * @returns the registered services in registration order
 */
export async function readDesiredServices(
  directory: string,
): Promise<RecordRead<DesiredService>> {
  return readRecord(
    join(directory, DESIRED_FILE),
    'services',
    isDesiredService,
  );
}

/**
 * replaces the desired services' record atomically
 * @param directory the state directory
 * @param services every registered service in registration order
 */
export async function writeDesiredServices(
  directory: string,
  services: readonly DesiredService[],
): Promise<void> {
  await writeRecord(directory, DESIRED_FILE, { services });
}

/**
 * reads the children a previous supervisor of this boot started
 * @param directory the run directory
 * @returns the recorded children
 */
export async function readChildren(
  directory: string,
): Promise<RecordRead<ChildRecord>> {
  return readRecord(join(directory, CHILDREN_FILE), 'children', isChildRecord);
}

/**
 * replaces the running children's record atomically
 * @param directory the run directory
 * @param children every child running now
 */
export async function writeChildren(
  directory: string,
  children: readonly ChildRecord[],
): Promise<void> {
  await writeRecord(directory, CHILDREN_FILE, { children });
}

/**
 * reads one record, refusing a file another account could have written
 * @param path absolute record path
 * @param field the field holding the entries
 * @param isEntry validator of one entry
 * @returns the valid entries and the reasons any were refused
 */
async function readRecord<T>(
  path: string,
  field: string,
  isEntry: (value: unknown) => value is T,
): Promise<RecordRead<T>> {
  const opened = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).then(
    (handle) => ({ handle }),
    (error: unknown) => ({
      isMissing: (error as NodeJS.ErrnoException).code === 'ENOENT',
    }),
  );
  if (!('handle' in opened)) {
    return {
      entries: [],
      refused: opened.isMissing ? [] : [`${path} cannot be opened`],
    };
  }
  const { handle } = opened;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & SHARED_BITS) !== 0 ||
      info.size > RECORD_LIMIT_BYTES
    ) {
      return {
        entries: [],
        refused: [`${path} is not the supervisor's own record`],
      };
    }
    const decoded: unknown = JSON.parse(await handle.readFile('utf8'));
    const entries: unknown =
      isRecord(decoded) && decoded.version === RECORD_VERSION
        ? decoded[field]
        : undefined;
    if (!Array.isArray(entries)) {
      return { entries: [], refused: [`${path} is malformed`] };
    }

    return {
      entries: entries.filter(isEntry),
      refused: entries.some((entry) => !isEntry(entry))
        ? [`${path} holds an entry that is not valid`]
        : [],
    };
  } catch {
    return { entries: [], refused: [`${path} is not valid JSON`] };
  } finally {
    await handle.close();
  }
}

/**
 * replaces one record: the contents go to a fresh private file no link can
 * redirect, which is synced and renamed over the record, and the directory is
 * synced after the rename so the new name survives a crash
 * @param directory absolute directory of the record
 * @param name record file name
 * @param body the record's fields beside its version
 */
async function writeRecord(
  directory: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    try {
      await handle.writeFile(
        `${JSON.stringify({ version: RECORD_VERSION, ...body })}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

/**
 * flushes a directory's entries to disk, so a rename into it survives a crash
 * @param directory absolute directory path
 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * validates one desired service entry
 * @param value untrusted decoded entry
 * @returns whether the entry holds a valid definition and status
 */
function isDesiredService(value: unknown): value is DesiredService {
  return (
    isRecord(value) &&
    isSupervisedService(value.definition) &&
    (value.desired === 'running' || value.desired === 'stopped')
  );
}

/**
 * validates one child entry
 * @param value untrusted decoded entry
 * @returns whether the entry names a service, a process and its start time
 */
function isChildRecord(value: unknown): value is ChildRecord {
  return (
    isHolderProcess(value) &&
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.pid > 1
  );
}
