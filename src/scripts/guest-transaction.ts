import { closeSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const lockDescriptor = 9;
const stageTimeoutMs = 60_000;
const payloadDirectory = '/opt/agent-sprite';
const maximumFrameChars = 16_777_216;
const state = { stopping: false };
const rootMode = 0o700;
const sharedMode = 0o755;
const stop = (): void => {
  state.stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (process.argv[2] === '--stage') {
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
      !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*\.js$/.test(file.name) ||
      typeof file.contents !== 'string' ||
      (file.mode !== rootMode && file.mode !== sharedMode)
    ) {
      throw new Error('Invalid manager payload');
    }
    const path = `${payloadDirectory}/${file.name}`;
    await mkdir(dirname(path), { recursive: true, mode: sharedMode });
    await chmod(dirname(path), sharedMode);
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
