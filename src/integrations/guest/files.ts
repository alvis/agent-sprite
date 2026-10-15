import { posix } from 'node:path';

import { runBoundedIO } from '#operation';

import { runGuest } from '../guest.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestFileParams } from './types.js';

/** the radix chmod reads a mode in */
const OCTAL = 8;
/** mode of a root file written without one: root's, readable by every account */
const DEFAULT_MODE = 0o644;

/**
 * the root program that replaces a file with its standard input atomically:
 * the parent is made when missing, the contents land in a private temporary
 * file beside the target, take their mode, then replace the target; its
 * arguments are the path and the octal mode
 */
const WRITE_PROGRAM = [
  'umask 022',
  'oa_directory=$(dirname "$1")',
  '{ test -d "$oa_directory" || mkdir -p "$oa_directory"; }',
  'oa_temporary=$(mktemp "$oa_directory/.open-agent-XXXXXXXXXX")',
  `trap 'rm -f "$oa_temporary"' EXIT`,
  'cat >"$oa_temporary"',
  'chmod "$2" "$oa_temporary"',
  'mv -f "$oa_temporary" "$1"',
].join(' && ');

/**
 * writes a root-owned guest file atomically with an explicit mode
 * @param guest target guest
 * @param params destination, contents, and optional permissions
 */
export async function writeGuestFile(
  guest: GuestChannel,
  params: GuestFileParams,
): Promise<void> {
  const { path, contents, mode = DEFAULT_MODE } = params;
  assertRootFilePath(path);
  await runGuest(
    guest,
    ['/bin/sh', '-c', WRITE_PROGRAM, 'oa-write', path, mode.toString(OCTAL)],
    { input: contents, step: 'guest file write' },
  );
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
  return runBoundedIO(async () => guest.read(path));
}

/**
 * checks whether a guest path exists
 * @param guest exact target guest
 * @param path absolute guest path
 * @returns whether the path exists
 */
export async function guestFileExists(
  guest: GuestChannel,
  path: string,
): Promise<boolean> {
  return runBoundedIO(async () => guest.exists(path));
}

/**
 * removes a root-controlled file, doing nothing when it is absent
 * @param guest exact target guest
 * @param path root-controlled guest path
 */
export async function removeGuestFile(
  guest: GuestChannel,
  path: string,
): Promise<void> {
  assertRootFilePath(path);
  await runGuest(guest, ['rm', '-f', '--', path], {
    step: 'guest file removal',
  });
}
