import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import {
  access,
  chmod,
  chown,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { posix } from 'node:path';
import { createInterface } from 'node:readline';

import { isRecord } from '../records.js';

import { parseRequest } from './request.js';

import type { Readable } from 'node:stream';

import type { WorkerRequest, RunRequest, WriteRequest } from './request.js';

/** bounded child output retained until actual process closure */
interface CapturedOutput {
  value: string;
  overflow: boolean;
}
/** private command completion returned to the host */
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const lockDescriptor = 9;
const outputLimitBytes = 1_048_576;
const idleTimeoutMs = 60_000;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const transientPaths = new Set<string>();
let accepting = true;
let active: Promise<void> | undefined;
let released = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

process.stdout.on('error', stop);
process.stdin.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
lines.on('close', stop);
lines.on('line', accept);
renew();
emit({ type: 'ready', installed: false });

/**
 * sends only protocol records, keeping command output inside its private result
 * @param event acknowledged guest state
 */
function emit(event: object): void {
  if (!process.stdout.destroyed) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

/** keeps idle host-side service work inside the healthy transaction lifetime */
function renew(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, idleTimeoutMs);
}

/**
 * admits one protected operation at a time, with separate liveness messages
 * @param line one complete JSON request
 */
function accept(line: string): void {
  if (!accepting) {
    return;
  }
  let request: WorkerRequest;
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) {
      throw new Error('Invalid transaction request');
    }
    if (value.type === 'stop') {
      stop();

      return;
    }
    if (value.type === 'heartbeat') {
      renew();

      return;
    }
    request = parseRequest(value);
    if (!Number.isSafeInteger(request.id) || active) {
      throw new Error('Invalid transaction request');
    }
  } catch {
    stop();

    return;
  }
  renew();
  emit({ type: 'accepted', id: request.id });
  active = execute(request)
    .then(
      (result) => emit({ type: 'settled', id: request.id, result }),
      (error) =>
        emit({
          type: 'settled',
          id: request.id,
          failure:
            typeof (error as NodeJS.ErrnoException).code === 'string'
              ? (error as NodeJS.ErrnoException).code
              : 'FAILED',
        }),
    )
    .finally(() => {
      active = undefined;
      if (!accepting) {
        void release();
      }
    });
}

/** stops admission without killing or unlocking around accepted filesystem work */
function stop(): void {
  accepting = false;
  clearTimeout(idleTimer);
  lines.close();
  if (!active) {
    void release();
  }
}

/** relinquishes ownership after accepted operations and registered cleanup settle */
async function release(): Promise<void> {
  if (released) {
    return;
  }
  released = true;
  const cleanup = await Promise.allSettled(
    [...transientPaths].map(async (path) => rm(path, { force: true })),
  );
  closeSync(lockDescriptor);
  emit({
    type: 'released',
    cleanupFailed: cleanup.some((result) => result.status === 'rejected'),
  });
  process.stdin.destroy();
}

/**
 * executes protected filesystem work inside the actual lock-owning process
 * @param request private command or filesystem operation
 * @returns operation result after the mutation settles
 */
async function execute(request: WorkerRequest): Promise<object> {
  switch (request.type) {
    case 'run':
      return run(request);
    case 'read':
      return { contents: await readFile(request.path, 'utf8') };
    case 'exists':
      try {
        await access(request.path);

        return { exists: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }

        return { exists: false };
      }
    case 'write':
      assertRootPath(request.path);
      if (request.removeOnRelease) {
        transientPaths.add(request.path);
      }
      await write(request);

      return {};
    case 'chown':
      assertRootPath(request.path);
      await chown(request.path, request.uid, request.gid);

      return {};
    case 'remove':
      assertRootPath(request.path);
      await rm(request.path, { force: true });

      return {};
    default:
      throw new Error('Invalid transaction operation');
  }
}

/**
 * preserves the root/native-home write boundary inside the guest executor
 * @param path requested root-owned path
 */
function assertRootPath(path: string): void {
  if (
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === '/home' ||
    path.startsWith('/home/') ||
    path.includes('\0')
  ) {
    throw new Error('Native homes require account-owned file operations');
  }
}

/**
 * commits one root-owned file by atomic rename under the same held lock
 * @param request destination, contents and permissions
 */
async function write(request: WriteRequest): Promise<void> {
  const temporary = `${request.path}.agent-sprite-${randomUUID()}`;
  try {
    await writeFile(temporary, request.contents, {
      mode: request.mode,
      flag: 'wx',
    });
    await chmod(temporary, request.mode);
    await rename(temporary, request.path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * executes a child with the inherited lock descriptor and waits for real closure
 * @param request command argv, optional environment and private stdin
 * @returns bounded private output and actual command status
 */
async function run(request: RunRequest): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = request.argv;
    const child = spawn(command!, args, {
      env: { ...process.env, ...request.env },
      stdio: [
        'pipe',
        'pipe',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        lockDescriptor,
      ],
    });
    const stdout = captureOutput(child.stdout!);
    const stderr = captureOutput(child.stderr!);
    let failure: Error | undefined;
    child.on('error', (error) => {
      failure = error;
    });
    child.stdin!.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        failure = error;
      }
    });
    child.on('close', (exitCode) => {
      if (failure || stdout.overflow || stderr.overflow) {
        reject(failure ?? new Error('Guest output exceeded its limit'));
      } else {
        resolve({
          stdout: stdout.value,
          stderr: stderr.value,
          exitCode: exitCode ?? 1,
        });
      }
    });
    child.stdin!.end(request.input);
  });
}

/**
 * captures bounded private text without killing a still-running writer
 * @param stream child output pipe
 * @returns accumulating private output
 */
function captureOutput(stream: Readable): CapturedOutput {
  const output = { value: '', overflow: false };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (
      Buffer.byteLength(output.value) + Buffer.byteLength(chunk) >
      outputLimitBytes
    ) {
      output.overflow = true;
    } else {
      output.value += chunk;
    }
  });

  return output;
}
