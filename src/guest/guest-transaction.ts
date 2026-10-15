import { closeSync } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const lockDescriptor = 9;
const stageTimeoutMs = 60_000;
// the launcher installs this first-stage worker alone under `guest/` in the
// guest root, so it cannot import guest-root.js before staging. The launcher
// names the root and the only account that may own it on the command line, and
// the worker accepts them only when they agree with where the worker runs: a
// symlinked `guest/` makes Node resolve the worker elsewhere, so the derived
// root moves and staging is refused
const derivedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [, , mode, requestedRoot, requestedOwner] = process.argv;
const guestRoot = requestedRoot ?? derivedRoot;
const guestOwner = Number(requestedOwner);
const maximumFrameChars = 16_777_216;
const state = { stopping: false };
const rootMode = 0o700;
const sharedMode = 0o755;
const dataMode = 0o644;
// compiled modules at their path under the guest root, and the data files the
// host seeds beside them
const stagedName =
  /^(?:(?:guest|drivers)(?:\/[a-z][a-z0-9-]*)+\.js|(?:harnesses|components)\.json)$/;
const dataName = /^(?:harnesses|components)\.json$/;
const isStagedMode = (name: string, mode: unknown): mode is number =>
  dataName.test(name)
    ? mode === dataMode
    : mode === rootMode || mode === sharedMode;
const stop = (): void => {
  state.stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (mode === '--stage') {
    await stagePayloads();
  }
  if (state.stopping || process.stdin.readableEnded) {
    release();
  } else {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    // staging must finish before resolving the worker's sibling dependencies
    const runtimeUrl = new URL(
      './guest-transaction/runtime.js',
      import.meta.url,
    );
    await import(runtimeUrl.href);
  }
} catch {
  process.exitCode = 1;
  release();
}

/** stages the fixed host-supplied manager assets before admitting requests */
async function stagePayloads(): Promise<void> {
  if (
    guestRoot !== derivedRoot ||
    !Number.isInteger(guestOwner) ||
    guestOwner < 0
  ) {
    throw new Error('Staging root does not agree with the worker location');
  }
  const frame = await readStageFrame();
  const files: unknown = JSON.parse(frame);
  if (!Array.isArray(files)) {
    throw new Error('Invalid payload frame');
  }
  for (const entry of files) {
    const file: unknown = entry;
    if (
      typeof file !== 'object' ||
      file === null ||
      !('name' in file) ||
      !('contents' in file) ||
      !('mode' in file) ||
      typeof file.name !== 'string' ||
      !stagedName.test(file.name) ||
      typeof file.contents !== 'string' ||
      !isStagedMode(file.name, file.mode)
    ) {
      throw new Error('Invalid manager payload');
    }
    const path = `${guestRoot}/${file.name}`;
    await shareDirectories(dirname(path));
    if ('ifAbsent' in file && file.ifAbsent === true && (await exists(path))) {
      continue;
    }
    const temporary = `${path}.staging-${process.pid}`;
    try {
      await writeFile(temporary, file.contents, {
        mode: file.mode,
        flag: 'wx',
      });
      await chmod(temporary, file.mode);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/**
 * walks from the guest root down to a directory, creating what is missing and
 * making each level readable by other accounts although the umask would make
 * it private; every level that already exists must be a real directory owned
 * by the expected account, so a link or a foreign directory cannot redirect
 * or take over what root later executes
 * @param directory absolute directory under the guest root
 * @throws {Error} when a level is a link, not a directory, or owned by another account
 */
async function shareDirectories(directory: string): Promise<void> {
  await requireOwnedDirectory(guestRoot);
  let current = guestRoot;
  for (const segment of relative(guestRoot, directory)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, segment);
    if (!(await lstat(current).catch(() => undefined))) {
      await mkdir(current, { mode: sharedMode });
    }
    await requireOwnedDirectory(current);
    await chmod(current, sharedMode);
  }
}

/**
 * refuses a path that is not a real directory owned by the expected account
 * @param path absolute directory path
 * @throws {Error} when the path is a link, not a directory, or owned by another account
 */
async function requireOwnedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== guestOwner) {
    throw new Error(`Untrusted staging directory: ${path}`);
  }
}

/**
 * checks whether a staged path already exists, without following a link
 * @param path absolute path under the guest root
 * @returns whether the path exists
 */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * bounds the initial private frame and settles interruption before release
 * @returns complete manager asset frame
 */
async function readStageFrame(): Promise<string> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let receivedBytes = 0;
  const interrupt = (): void => {
    input.close();
  };
  const count = (chunk: Buffer | string): void => {
    receivedBytes += Buffer.byteLength(chunk);
    if (receivedBytes > maximumFrameChars) {
      input.close();
    }
  };
  process.stdin.on('data', count);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const timer = setTimeout(interrupt, stageTimeoutMs);
  try {
    return await new Promise<string>((resolve, reject) => {
      input.once('line', (line) => {
        if (Buffer.byteLength(line) > maximumFrameChars) {
          reject(new Error('Payload frame exceeded its limit'));
        } else {
          resolve(line);
        }
        input.close();
      });
      input.once('close', () =>
        reject(new Error('Payload staging ended early')),
      );
      input.once('error', reject);
    });
  } finally {
    clearTimeout(timer);
    process.stdin.off('data', count);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    input.close();
  }
}

/** releases the same inherited lock only after staging has settled */
function release(): void {
  closeSync(lockDescriptor);
  process.stdout.write(`${JSON.stringify({ type: 'released' })}\n`);
  process.stdin.destroy();
}
