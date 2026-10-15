import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { TOOL_LINK_DIRECTORY } from '../homebrew.js';

const RECORD_MODE = 0o644;
const FIELD_SEPARATOR = '\t';
const UNSAFE_FIELD = /[\t\n\r]/u;

/**
 * records a link in the tool link directory, replacing the earlier line for
 * the same path, so a provider that rebuilds its root filesystem on boot can
 * restore it; a link anywhere else is not recorded
 * @param record absolute path of the root-owned record
 * @param target absolute path the link points to
 * @param path absolute path of the link
 * @throws {Error} when a recorded link has a relative target or a tab or line break in either path
 */
export async function recordLink(
  record: string,
  target: string,
  path: string,
): Promise<void> {
  if (dirname(path) !== TOOL_LINK_DIRECTORY) {
    return;
  }
  if (!isAbsolute(target) || UNSAFE_FIELD.test(target + path)) {
    throw new Error(`${path} cannot be recorded as a link to ${target}`);
  }
  const links = await readRecord(record);
  links.set(path, target);
  const temporary = `${record}.${process.pid}.new`;
  try {
    await writeFile(
      temporary,
      [...links]
        .map(([from, to]) => `${from}${FIELD_SEPARATOR}${to}\n`)
        .join(''),
      { mode: RECORD_MODE },
    );
    // the installer's umask must not decide who can read the record
    await chmod(temporary, RECORD_MODE);
    await rename(temporary, record);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * reads the recorded links, leaving out any line without a path and a target
 * @param record absolute path of the record
 * @returns the target of each recorded path, in recorded order; empty when nothing is recorded yet
 */
async function readRecord(record: string): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  let text = '';
  try {
    text = await readFile(record, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  for (const line of text.split('\n')) {
    const separator = line.indexOf(FIELD_SEPARATOR);
    if (separator > 0 && separator < line.length - 1) {
      links.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  return links;
}
