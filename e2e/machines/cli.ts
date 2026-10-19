import { join } from 'node:path';

import { execa } from 'execa';

import { TEST_PREFIX } from './identity';

import type { CommandData } from '#application/data';

import type { Redactor } from './redaction';

/** single structured result printed by the packed CLI with --json */
export interface CliEnvelope {
  /** output schema version */
  schemaVersion: number;
  /** executed command */
  command: string;
  /** whether the command succeeded */
  ok: boolean;
  /** success payload */
  data?: unknown;
  /** failure classification */
  error?: { code: string; message: string; details?: string[] };
}

/** redacted outcome of one non-interactive invocation */
export interface CliOutcome {
  /** process exit code, absent when killed by a signal */
  exitCode?: number;
  /** parsed, redacted JSON result */
  envelope: CliEnvelope;
  /** redacted standard error */
  stderr: string;
}

/** the packed executable driven with an isolated home and the e2e credentials */
export interface MachineCli {
  /**
   * runs one non-interactive JSON command
   * @param args command and its arguments
   * @param timeoutMs time before cooperative cancellation
   * @param signal aborts the command early, such as on a test timeout
   * @returns redacted outcome
   */
  json(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CliOutcome>;
}

/** packed executable, isolated home, and output redaction */
export interface MachineCliOptions {
  /** installed packed executable */
  bin: string;
  /** isolated HOME keeping local credentials and config out of the run */
  home: string;
  /** removes credential values from captured output */
  redact: Redactor;
}

const FORCE_KILL_AFTER_MS = 60_000;
const OUTPUT_TAIL_LENGTH = 4_000;

/** flags every invocation shares: nothing saved on this computer is read */
export const SHARED_FLAGS = ['--no-local-credentials'];

/**
 * the configuration home of the product drivers the specs import in-process,
 * set as XDG_CONFIG_HOME before the workers start, so their flyctl state
 * lives in the run, apart from the owner's and every CLI home's; its
 * one-letter segment keeps flyctl's agent socket path within macOS's limit
 * @param runHome the run's isolated home
 * @returns absolute configuration directory
 */
export function driverConfigHome(runHome: string): string {
  return join(runHome, 'd', '.config');
}

/**
 * builds the whole environment of one packed CLI process: nothing of this
 * computer's environment but PATH, an isolated home, and every `TEST_*`
 * credential under the name the CLI reads, without its prefix
 * @param home isolated HOME of the run
 * @returns child environment, used with `extendEnv: false`
 */
export function cliEnvironment(home: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) =>
        name.startsWith(TEST_PREFIX) && value
          ? [[name.slice(TEST_PREFIX.length), value]]
          : [],
      ),
    ),
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    NO_COLOR: '1',
  };
}

/**
 * creates the CLI driver of the machine specs
 * @param options packed executable, isolated home and redaction
 * @returns CLI driver
 */
export function createMachineCli(options: MachineCliOptions): MachineCli {
  const { bin, home, redact } = options;
  const env = cliEnvironment(home);

  return {
    async json(args, timeoutMs, signal) {
      const result = await execa(
        bin,
        [...args, '--json', '--non-interactive', ...SHARED_FLAGS],
        {
          env,
          extendEnv: false,
          reject: false,
          timeout: timeoutMs,
          cancelSignal: signal,
          killSignal: 'SIGINT',
          forceKillAfterDelay: FORCE_KILL_AFTER_MS,
        },
      );
      const stdout = redact(result.stdout);
      const stderr = redact(result.stderr);

      return {
        exitCode: result.exitCode,
        envelope: parseEnvelope(stdout, {
          args,
          exitCode: result.exitCode,
          stderr,
        }),
        stderr,
      };
    },
  };
}

/**
 * returns the typed payload of a successful command result
 * @param outcome redacted CLI outcome
 * @param command expected command
 * @returns success payload
 */
export function successData<Command extends keyof CommandData>(
  outcome: CliOutcome,
  command: Command,
): CommandData[Command] {
  const { envelope } = outcome;
  if (envelope.command !== command || !envelope.ok) {
    throw new Error(
      `${command} did not succeed (exit ${outcome.exitCode}): ` +
        `${JSON.stringify(envelope.error ?? envelope)}\n${tail(outcome.stderr)}`,
    );
  }

  return envelope.data as CommandData[Command];
}

/**
 * keeps the end of long command output for failure reports
 * @param text redacted output
 * @returns at most the last few thousand characters
 */
export function tail(text: string): string {
  return text.slice(-OUTPUT_TAIL_LENGTH);
}

/**
 * parses the single JSON result or reports the redacted output
 * @param stdout redacted standard output
 * @param context invocation details for the failure report
 * @param context.args command arguments without shared flags
 * @param context.exitCode observed exit code
 * @param context.stderr redacted standard error
 * @returns parsed envelope
 */
function parseEnvelope(
  stdout: string,
  context: { args: string[]; exitCode?: number; stderr: string },
): CliEnvelope {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  })();
  if (!isEnvelope(parsed)) {
    throw new Error(
      `${context.args.join(' ')} printed no JSON result (exit ${context.exitCode})\n` +
        `stdout: ${tail(stdout)}\nstderr: ${tail(context.stderr)}`,
    );
  }

  return parsed;
}

/**
 * checks the fields every JSON result carries
 * @param value parsed standard output
 * @returns true for a versioned command result
 */
function isEnvelope(value: unknown): value is CliEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    typeof value.schemaVersion === 'number' &&
    'command' in value &&
    typeof value.command === 'string' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}
