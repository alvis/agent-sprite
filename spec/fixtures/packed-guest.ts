import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';

// packed-package helpers the packaged guest proofs share: they locate the
// packed CLI under test and run its first-stage worker

/**
 * locates the packed package under test
 * @returns package root of the packed CLI
 */
export async function packageRoot(): Promise<string> {
  const packedBin = process.env.OPEN_AGENT_PACKED_BIN;
  if (!packedBin) {
    throw new Error('Guest payload proofs require the packed E2E runner');
  }

  return dirname(dirname(await realpath(packedBin)));
}

/**
 * runs the packed first-stage worker over a frame, as the launcher does
 * @param root packed package root
 * @param guestRoot temporary guest root
 * @param request what to stage and who may own it
 * @param request.frame staging frame to send
 * @param request.owner account the worker accepts as owner of the staged directories
 * @returns the worker's exit code and standard error
 */
export async function runStage(
  root: string,
  guestRoot: string,
  request: { frame: unknown; owner?: number },
): Promise<{ exitCode: number | null; stderr: string }> {
  const { frame, owner = process.getuid?.() ?? 0 } = request;
  const worker = join(guestRoot, 'guest/guest-transaction.js');
  await mkdir(dirname(worker), { recursive: true });
  await copyFile(join(root, 'lib/guest/guest-transaction.js'), worker);
  const descriptor = openSync(join(guestRoot, '.lock'), 'w');
  // the launcher runs the worker under this umask, which would make every
  // directory the worker creates private; the root it names is the resolved
  // one, because Node resolves the worker's own location the same way
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'umask 077; exec "$@"',
      'sh',
      execPath,
      worker,
      '--stage',
      await realpath(guestRoot),
      String(owner),
    ],
    {
      stdio: [
        'pipe',
        'ignore',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        descriptor,
      ],
    },
  );
  closeSync(descriptor);
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  child.stdin!.end(`${JSON.stringify(frame)}\n`);
  const [exitCode] = (await closed) as [number | null];

  return { exitCode, stderr };
}
