import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '../records.js';

import {
  TEMPORARY_PREFIX,
  readUntrustedJson,
  removeFile,
  writeAtomically,
} from './files.js';
import { SESSION_HASH, SOURCE_NAME } from './names.js';
import { isHolderProcess } from './process-identity.js';

import type { HolderActivity } from './deadline.js';

// guest kernel: imports only Node built-ins and other guest code. One file per
// holder (a source and session pair) lives in an awake directory; its name is
// derived from a hash of the pair, never from raw input, and its contents are
// validated in full before any field is used. A scan matches holder names
// before it counts them against its bound, so entries of any other name can
// never push a holder out of it, and a scan that could not see every holder
// says so, for the governor to fail closed

/** largest holder file a reader accepts, in bytes */
const HOLDER_MAX_BYTES = 1024;
/** most holder files one scan reads */
const HOLDER_LIMIT = 512;
/** most directory entries one scan walks, so a flooded directory cannot stall an event */
const ENTRY_WALK_LIMIT = 8_192;
const HOLDER_FILE = /^h-[0-9a-f]{64}\.json$/;

/** a holder as its file stores it */
type HolderFile = Omit<HolderActivity, 'process'> & {
  /** file format version */
  version: 1;
  /** process id of a managed hold's process */
  pid?: number;
  /** start time of a managed hold's process */
  processStart?: string;
};

/** one valid holder file */
export interface ScannedHolder {
  /** the file's name within the awake directory */
  name: string;
  /** the holder's recorded activity */
  holder: HolderActivity;
}

/** the holders one scan found, what it refused and whether it saw them all */
export interface HolderScan {
  /** every valid holder */
  holders: ScannedHolder[];
  /** names of holder files refused as invalid, which the directory's owner prunes */
  refused: string[];
  /** names of temporary files, which the directory's owner prunes once abandoned */
  temporaries: string[];
  /** names of every other entry, which the directory's owner may remove */
  others: string[];
  /** why the scan could not see every holder; absent when it saw them all */
  incomplete?: string;
}

/**
 * hashes a session identifier, so neither a file name nor the recorded state
 * carries it verbatim
 * @param session validated session identifier
 * @returns SHA-256 of the identifier, in hexadecimal
 */
export function hashSession(session: string): string {
  return createHash('sha256').update(session).digest('hex');
}

/**
 * names the file of one holder
 * @param source validated source name
 * @param session hashed session identifier
 * @returns the file name within the awake directory
 */
export function holderFileName(source: string, session: string): string {
  const digest = createHash('sha256')
    .update([source, session].join('\0'))
    .digest('hex');

  return `h-${digest}.json`;
}

/**
 * reads one holder, treating its file as untrusted
 * @param directory absolute awake directory
 * @param name holder file name
 * @param owners user ids that may own a holder file
 * @returns the holder, or undefined when it is missing or invalid
 */
export async function readHolder(
  directory: string,
  name: string,
  owners: ReadonlySet<number>,
): Promise<HolderActivity | undefined> {
  const read = await readUntrustedJson(join(directory, name), {
    owners,
    maxBytes: HOLDER_MAX_BYTES,
  });

  return 'value' in read && isHolderFile(read.value, name)
    ? toActivity(read.value)
    : undefined;
}

/**
 * reads every holder in an awake directory, refusing links, foreign file
 * types and owners, oversized or malformed files, and a file whose name does
 * not match its contents; only holder names count against the holder bound
 * @param directory absolute awake directory
 * @param owners user ids that may own a holder file
 * @returns the valid holders, the names to prune, and why the scan is
 * incomplete when it could not see every holder
 */
export async function scanHolders(
  directory: string,
  owners: ReadonlySet<number>,
): Promise<HolderScan> {
  const scan: HolderScan = {
    holders: [],
    refused: [],
    temporaries: [],
    others: [],
  };
  const names = await holderNames(directory, scan);
  for (const name of names) {
    const read = await readUntrustedJson(join(directory, name), {
      owners,
      maxBytes: HOLDER_MAX_BYTES,
    });
    if ('missing' in read) {
      continue;
    }
    if ('value' in read && isHolderFile(read.value, name)) {
      scan.holders.push({ name, holder: toActivity(read.value) });
    } else {
      scan.refused.push(name);
    }
  }

  return scan;
}

/**
 * records one holder atomically
 * @param directory absolute awake directory
 * @param holder the holder's new activity
 */
export async function writeHolder(
  directory: string,
  holder: HolderActivity,
): Promise<void> {
  const { source, session, lastHeartbeat, holdExpiresAt } = holder;
  const owner = holder.process;
  await writeAtomically(
    directory,
    holderFileName(source, session),
    `${JSON.stringify({
      version: 1,
      source,
      session,
      lastHeartbeat,
      ...(holdExpiresAt !== undefined && { holdExpiresAt }),
      ...(owner !== undefined && {
        pid: owner.pid,
        processStart: owner.start,
      }),
    })}\n`,
  );
}

/**
 * removes entries by name; removal never follows a link, a file another
 * writer removed first is no failure, and an entry that cannot be removed,
 * such as a directory, is left for the scan to keep ignoring
 * @param directory absolute awake directory
 * @param names entry names within the directory
 */
export async function removeEntries(
  directory: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    await removeFile(join(directory, name)).catch(() => undefined);
  }
}

/**
 * walks an awake directory once, sorting its entries into holder names,
 * temporary files and others, and noting in the scan when the walk stopped
 * before the end or could not start
 * @param directory absolute awake directory
 * @param scan the scan whose temporaries, others and incompleteness to record
 * @returns the holder file names, at most the holder bound
 */
async function holderNames(
  directory: string,
  scan: HolderScan,
): Promise<string[]> {
  const names: string[] = [];
  let walked = 0;
  try {
    // leaving the loop early closes the directory handle
    for await (const { name } of await opendir(directory)) {
      walked += 1;
      if (walked > ENTRY_WALK_LIMIT) {
        scan.incomplete = `it holds more than ${ENTRY_WALK_LIMIT} entries`;
        break;
      }
      if (!HOLDER_FILE.test(name)) {
        (name.startsWith(TEMPORARY_PREFIX)
          ? scan.temporaries
          : scan.others
        ).push(name);
      } else if (names.length < HOLDER_LIMIT) {
        names.push(name);
      } else {
        scan.incomplete = `it holds more than ${HOLDER_LIMIT} holder files`;
        break;
      }
    }
  } catch {
    scan.incomplete = 'it could not be read';
  }

  return names;
}

/**
 * validates a decoded holder file against its name
 * @param value untrusted decoded file
 * @param name the name the file is stored under
 * @returns whether the file is a complete holder stored under its own name
 */
function isHolderFile(value: unknown, name: string): value is HolderFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.source === 'string' &&
    SOURCE_NAME.test(value.source) &&
    typeof value.session === 'string' &&
    SESSION_HASH.test(value.session) &&
    isEpoch(value.lastHeartbeat) &&
    (value.holdExpiresAt === undefined || isEpoch(value.holdExpiresAt)) &&
    (value.pid === undefined
      ? value.processStart === undefined
      : isHolderProcess({ pid: value.pid, start: value.processStart })) &&
    holderFileName(value.source, value.session) === name
  );
}

/**
 * keeps only the activity fields of a validated holder file
 * @param holder validated holder file
 * @returns the holder's activity
 */
function toActivity(holder: HolderFile): HolderActivity {
  const { source, session, lastHeartbeat, holdExpiresAt, pid, processStart } =
    holder;

  return {
    source,
    session,
    lastHeartbeat,
    ...(holdExpiresAt !== undefined && { holdExpiresAt }),
    ...(pid !== undefined &&
      processStart !== undefined && { process: { pid, start: processStart } }),
  };
}

/**
 * validates an epoch-milliseconds field
 * @param value untrusted field
 * @returns whether the value is a non-negative safe integer
 */
function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
