import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Stats } from 'node:fs';

/** destination confined to the executing native account home */
export interface NativeFileParams {
  home: string;
  path: string;
}
/** private contents written atomically by the owning account */
export interface NativeFileWriteParams extends NativeFileParams {
  contents: string;
}

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const writableByOthers = 0o022;
const maximumLinks = 40;

/** typed guest-local refusal for an unsafe runtime filesystem state */
class NativeFilePreflightFault extends Error {
  public readonly code = 'PREFLIGHT';
  /** @param message unsafe path or filesystem diagnostic */
  constructor(message: string) {
    super(message);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runNativeFiles();
}

/**
 * dispatches managed home-file operations after the caller drops privileges
 * @returns after the requested operation completes
 */
async function runNativeFiles(): Promise<void> {
  const [operation, home, path] = process.argv.slice(2);
  if (!home || !path || !['/home/agent', '/home/sprite'].includes(home)) {
    throw new Error('Native file operations require a managed account home');
  }
  switch (operation) {
    case 'mkdir':
      return ensureNativeDirectory({ home, path });
    case 'write':
      return writeNativeFile({ home, path, contents: await readInput() });
    case 'remove':
      return removeNativeFile({ home, path });
    default:
      throw new Error('Unknown native file operation');
  }
}

/**
 * creates private directories without borrowing root filesystem privileges
 * @param params owning home and directory
 * @param params.home owning native account home
 * @param params.path normalized destination within the home
 * @returns after every component is checked and created
 */
export async function ensureNativeDirectory({
  home,
  path,
}: NativeFileParams): Promise<void> {
  validateNativePath(home, path);
  await inspectNativeDirectory(home, path, true);
  await chmod(path, privateDirectoryMode);
}

/**
 * replaces one native file atomically with a private, exclusively created file
 * @param params destination and complete replacement text
 * @param params.home owning native account home
 * @param params.path normalized destination within the home
 * @param params.contents complete replacement text
 * @returns after the complete file replaces its prior contents
 */
export async function writeNativeFile({
  home,
  path,
  contents,
}: NativeFileWriteParams): Promise<void> {
  validateNativePath(home, path);
  await inspectNativeDirectory(home, dirname(path));
  await inspectNativeFile(path);
  const temporaryPath = join(dirname(path), `.agent-sprite-${randomUUID()}`);
  const file = await open(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    privateFileMode,
  );
  try {
    try {
      await file.writeFile(contents, 'utf8');
    } finally {
      await file.close();
    }
    await inspectNativeDirectory(home, dirname(path));
    await inspectNativeFile(path);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

/**
 * removes only a regular file owned by the executing native account
 * @param params owning home and file
 * @param params.home owning native account home
 * @param params.path normalized destination within the home
 * @returns after removal or confirmation that the file is absent
 */
export async function removeNativeFile({
  home,
  path,
}: NativeFileParams): Promise<void> {
  validateNativePath(home, path);
  await inspectNativeDirectory(home, dirname(path));
  if (await inspectNativeFile(path)) {
    await unlink(path);
  }
}

/**
 * rejects root execution and paths outside the intended home before any mutation
 * @param home owning account home
 * @param path requested file or directory
 */
function validateNativePath(home: string, path: string): void {
  if (!process.getuid || process.getuid() === 0) {
    throw new Error(
      'Native file operations must run as the owning non-root account',
    );
  }
  if (
    typeof path !== 'string' ||
    !isAbsolute(home) ||
    normalize(home) !== home ||
    !path.startsWith(`${home}/`) ||
    normalize(path) !== path ||
    path.includes('\0')
  ) {
    throw new Error(
      'Native file path must be normalized and inside its owning home',
    );
  }
}

/**
 * refuses symlink traversal and foreign-owned home components
 * @param home owning account home
 * @param path directory to inspect
 * @param create whether missing subdirectories should be created
 * @returns after every directory component is checked
 */
async function inspectNativeDirectory(
  home: string,
  path: string,
  create = false,
): Promise<void> {
  let current = '/';
  for (const component of path.split('/').filter(Boolean)) {
    current = join(current, component);
    const inHome = current === home || current.startsWith(`${home}/`);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        !create ||
        !current.startsWith(`${home}/`)
      ) {
        throw error;
      }
      await mkdir(current, { mode: privateDirectoryMode });
      info = await lstat(current);
    }
    if (!info.isDirectory() || (inHome && info.uid !== process.getuid!())) {
      throw new NativeFilePreflightFault(
        `Native directory is linked or has unexpected ownership: ${current}`,
      );
    }
  }
}

/**
 * accepts only absent or regular native files belonging to the current account
 * @param path native destination
 * @returns whether the checked file exists
 */
async function inspectNativeFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid!()) {
      throw new NativeFilePreflightFault(
        `Native file is linked or has unexpected ownership: ${path}`,
      );
    }

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * receives private file contents over stdin rather than process arguments
 * @returns complete UTF-8 contents
 */
async function readInput(): Promise<string> {
  process.stdin.setEncoding('utf8');
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }

  return chunks.join('');
}

/**
 * resolves a root-controlled file, checking every ancestor and symlink target
 * @param path absolute executable or interpreted payload path
 * @param followedLinks number of symlinks already followed
 * @returns resolved file beneath exclusively root-controlled paths
 */
export async function resolveTrustedFile(
  path: string,
  followedLinks = 0,
): Promise<string> {
  if (!isAbsolute(path) || normalize(path) === '/') {
    throw new Error(`Untrusted root execution path: ${path}`);
  }
  if (followedLinks > maximumLinks) {
    throw new NativeFilePreflightFault(
      `Untrusted root execution path: ${path}`,
    );
  }
  let current = '/';
  const components = normalize(path).split('/').filter(Boolean);
  const root = await lstat(current);
  if (root.uid !== 0 || (root.mode & writableByOthers) !== 0) {
    throw new NativeFilePreflightFault(
      'Root execution requires a root-controlled filesystem',
    );
  }
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.uid !== 0) {
      throw new NativeFilePreflightFault(
        `Untrusted root execution path: ${current}`,
      );
    }
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(current), await readlink(current));

      return resolveTrustedFile(
        join(target, ...components.slice(index + 1)),
        followedLinks + 1,
      );
    }
    const isLeaf = index === components.length - 1;
    if (
      (info.mode & writableByOthers) !== 0 ||
      (isLeaf ? !info.isFile() : !info.isDirectory())
    ) {
      throw new NativeFilePreflightFault(
        `Untrusted root execution path: ${current}`,
      );
    }
  }

  return current;
}
