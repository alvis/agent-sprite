import { posix } from 'node:path';

import { CommandFault } from '#errors';

import { sanitizeGuestDiagnostic } from './guest/diagnostics.js';
import { runSessionCommand } from './guest/session-guest.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type {
  GuestRunOptions,
  GuestRunResult,
  GuestCommandResult,
} from './guest/types.js';

export type {
  GuestRunOptions,
  GuestRunResult,
  GuestCommandResult,
  GuestFileParams,
} from './guest/types.js';

const guestDiagnosticLimit = 512;
const guestStepLimit = 80;

/**
 * executes an argument array without invoking a shell or leaking output on failure
 * @param guest target guest
 * @param argv executable and argument array
 * @param options command input, environment, timeout, and safe step label
 * @returns captured output from a successful command
 */
export async function runGuest(
  guest: GuestChannel,
  argv: readonly string[],
  options: GuestRunOptions = {},
): Promise<GuestRunResult> {
  const result = await runGuestResult(guest, argv, options);
  if (result.exitCode !== 0) {
    const step = sanitizeGuestDiagnostic(
      options.step ?? posix.basename(argv[0] ?? 'unknown'),
    ).slice(0, guestStepLimit);
    const tail = sanitizeGuestDiagnostic(result.stderr).slice(
      -guestDiagnosticLimit,
    );
    const tailSuffix = tail ? `: ${tail}` : '';
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Guest ${step} exited with status ${result.exitCode}${tailSuffix}`,
    });
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * returns a bounded guest command's exit status without exposing output in
 * errors; a secret input needs a channel that runs over a setup session
 * @param guest target guest
 * @param argv executable and argument array
 * @param options command input or secret, environment, and timeout
 * @returns captured output and exit status
 */
export async function runGuestResult(
  guest: GuestChannel,
  argv: readonly string[],
  options: GuestRunOptions = {},
): Promise<GuestCommandResult> {
  const [file, ...args] = argv;
  if (!file) {
    throw new Error('Guest command must contain an executable');
  }
  if (options.secret) {
    return runSessionCommand(
      guest,
      {
        program: file,
        arguments: args,
        environment: options.env,
        timeoutMs: options.timeoutMs,
      },
      { kind: 'secret', ...options.secret },
    );
  }

  return guest.exec({
    program: file,
    arguments: args,
    environment: options.env,
    input: options.input,
    timeoutMs: options.timeoutMs,
  });
}

export {
  writeGuestFile,
  assertRootFilePath,
  readGuestFile,
  guestFileExists,
  removeGuestFile,
} from './guest/files.js';
