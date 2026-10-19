import type { CommandError } from '#application/failures';
import type { CommandErrorCode } from '#kernel/faults';

/** portable D10 status derived from the shared failure table */
type CommandExitCode = 0 | (typeof FAILURE_EXIT_CODES)[CommandErrorCode];

const FAILURE_EXIT_CODES = {
  USAGE: 2,
  INPUT: 1,
  AUTH: 1,
  PREFLIGHT: 1,
  CONFLICT: 1,
  PROVIDER: 1,
  CANCELLED: 130,
  UNEXPECTED: 1,
} as const;

/**
 * applies the same D10 process status to human and JSON results
 * @param result completed command or parser result
 * @returns portable process exit status
 */
export function resultExitCode<
  T extends { ok: true } | { ok: false; error: Pick<CommandError, 'code'> },
>(result: T): CommandExitCode {
  return result.ok ? 0 : FAILURE_EXIT_CODES[result.error.code];
}
