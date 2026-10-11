import { APIError, ExecError, FilesystemError } from '@fly/sprites';

import { InteractionExit } from '#navigation/exit';
import { redactResolved } from '#utilities/redaction';

import type { CommandError, CommandErrorCode } from '#command/contracts';

/** expected fault identity and diagnostic cause */
export interface CommandFaultParams extends ErrorOptions {
  code: CommandErrorCode;
  message: string;
  causeVisibility?: 'public' | 'private';
}

/** portable D10 status derived from the shared failure table */
export type CommandExitCode = 0 | (typeof FAILURE_EXIT_CODES)[CommandErrorCode];

const UNAUTHENTICATED_STATUS = 401;
const ACCESS_DENIED_STATUS = 403;
const CONFLICT_STATUS = 409;
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
const diagnosticLimit = 256;
const diagnosticCount = 6;
interface RecoveryState {
  originalCause: unknown;
  failures: Error[];
  details: string[];
}

const recoveryState = new WeakMap<Error, RecoveryState>();

/**
 * Retains a cleanup failure on the original operation error.
 * @param primary original failure
 * @param step recovery operation
 * @param failure secondary failure
 * @returns original Error identity with bounded details
 */
export function retainRecoveryFailure(
  primary: unknown,
  step: string,
  failure: unknown,
): Error {
  const error = ensureError(primary);
  const state = recoveryState.get(error) ?? {
    originalCause: error.cause,
    failures: [],
    details: [],
  };
  const recoveryFailure = ensureError(failure);
  state.failures.push(recoveryFailure);
  if (state.details.length < diagnosticCount) {
    state.details.push(
      `Recovery ${safeDiagnostic(step)} failed: ${safeDiagnostic(recoveryFailure.message)}`,
    );
  }
  recoveryState.set(error, state);
  const causes = [
    ...(state.originalCause === undefined ? [] : [state.originalCause]),
    ...state.failures,
  ];
  try {
    error.cause = new AggregateError(
      causes,
      'Operation recovery had additional failures',
    );
  } catch {
    /* frozen errors retain their actual recovery failures in recoveryState */
  }

  return error;
}

/**
 * Redacts and bounds one public diagnostic.
 * @param value untrusted diagnostic text
 * @returns safe one-line detail
 */
function safeDiagnostic(value: string): string {
  return redactResolved(value)
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, diagnosticLimit);
}

/** expected domain failure with an explicit D10 category */
export class CommandFault extends Error {
  public readonly code: CommandErrorCode;
  public readonly causeVisibility: 'public' | 'private';

  /**
   * retains the machine-readable category and original failure
   * @param params D10 category, actionable diagnostic, and original failure
   * @param params.code D10 failure category
   * @param params.message actionable diagnostic
   * @param params.cause original rejection when wrapping a failure
   * @param params.causeVisibility whether the cause can appear in public details
   */
  constructor({
    code,
    message,
    cause,
    causeVisibility = 'public',
  }: CommandFaultParams) {
    super(message, { cause });
    this.name = 'CommandFault';
    this.code = code;
    this.causeVisibility = causeVisibility;
  }
}

/**
 * normalizes JavaScript rejection values at the application boundary
 * @param exception thrown value
 * @returns an Error retaining the original value as its cause
 */
export function ensureError(exception: unknown): Error {
  if (exception instanceof Error) {
    return exception;
  }

  return new Error(
    typeof exception === 'string'
      ? exception
      : 'An unexpected non-Error failure occurred.',
    { cause: exception },
  );
}

/**
 * maps typed domain and SDK failures without interpreting message strings
 * @param exception caught failure
 * @returns safe D10 error details
 */
export function commandError(exception: unknown): CommandError {
  const error = ensureError(exception);
  const code = errorCode(error);
  const state = recoveryState.get(error);
  const details = [
    ...(state?.details ?? []),
    ...publicCauseDetails(error, state),
  ].slice(0, diagnosticCount);

  return {
    code,
    message: safeDiagnostic(error.message),
    details: details.length > 0 ? details : undefined,
  };
}

/**
 * Reads bounded public causes while respecting a private provider-body boundary.
 * @param error primary failure
 * @param state retained recovery state, if present
 * @returns safe public cause details
 */
function publicCauseDetails(error: Error, state?: RecoveryState): string[] {
  if (error instanceof CommandFault && error.causeVisibility === 'private') {
    return [];
  }
  const details: string[] = [];
  const pending = [state ? state.originalCause : error.cause];
  const visited = new Set<unknown>();
  while (pending.length > 0 && details.length < diagnosticCount) {
    const cause = pending.shift();
    if (cause === null || cause === undefined || visited.has(cause)) {
      continue;
    }
    visited.add(cause);
    const detail = publicCauseDetail(cause, pending);
    if (detail) {
      details.push(detail);
    }
  }

  return details;
}

/**
 * Formats one visible cause and queues only its permitted children.
 * @param cause candidate cause
 * @param pending remaining cause nodes
 * @returns public detail, if present
 */
function publicCauseDetail(
  cause: unknown,
  pending: unknown[],
): string | undefined {
  if (cause instanceof Error) {
    if (cause instanceof AggregateError) {
      pending.push(...(cause.errors as unknown[]));
    }
    if (!(
      cause instanceof CommandFault && cause.causeVisibility === 'private'
    )) {
      pending.push(cause.cause);
    }

    return `Cause: ${safeDiagnostic(cause.message)}`;
  }

  return typeof cause === 'string'
    ? `Cause: ${safeDiagnostic(cause)}`
    : undefined;
}

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

/**
 * categorizes SDK HTTP failures independently of diagnostic text
 * @param status observed provider HTTP status
 * @returns D10 authentication, conflict, or provider category
 */
export function providerErrorCode(
  status: number | undefined,
): CommandErrorCode {
  if (status === UNAUTHENTICATED_STATUS || status === ACCESS_DENIED_STATUS) {
    return 'AUTH';
  }

  return status === CONFLICT_STATUS ? 'CONFLICT' : 'PROVIDER';
}

/**
 * maps known error identities while leaving unclassified failures unexpected
 * @param error normalized JavaScript error
 * @returns one D10 category
 */
function errorCode(error: Error): CommandErrorCode {
  if (error instanceof CommandFault) {
    return error.code;
  }
  if (error instanceof InteractionExit && error.action === 'cancel') {
    return 'CANCELLED';
  }
  if (error instanceof APIError) {
    return providerErrorCode(error.statusCode);
  }
  if (error instanceof ExecError || error instanceof FilesystemError) {
    return 'PROVIDER';
  }

  return 'UNEXPECTED';
}
