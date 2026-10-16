import { posix } from 'node:path';

import { CommandFault } from '#errors';

import { sanitizeGuestDiagnostic } from './diagnostics.js';
import { runSessionCommand } from './session/channel.js';

import type { NetworkId } from '#core/catalog';
import type { GuestChannel } from '#drivers/guest-channel';
import type { NetworkIdentity } from '#drivers/networks/contracts';

import type { Secret } from './session/secret.js';

/** retained non-secret network device identity for authorised cleanup */
export interface GuestNetworkIdentity extends NetworkIdentity {
  /** the network whose device this identity names, which stays owner after a switch */
  network: NetworkId;
}

/** arguments for a bounded guest command */
export interface GuestRunOptions {
  input?: string;
  /** a credential the command receives instead of `input`, only over a setup session */
  secret?: {
    /** the credential */
    value: Secret;
    /** piped to standard input, or written to a private file named in `OPEN_AGENT_SECRET_FILE` */
    as: 'stdin' | 'shm-file';
  };
  env?: Record<string, string>;
  timeoutMs?: number;
  step?: string;
}

/** captured output of a successful guest command */
export interface GuestRunResult {
  stdout: string;
  stderr: string;
}

/** raw guest exit result for native commands with structured idempotent failures */
export interface GuestCommandResult extends GuestRunResult {
  exitCode: number;
}

/** destination, content, and permissions for an atomic guest file write */
export interface GuestFileParams {
  path: string;
  contents: string;
  mode?: number;
}

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
