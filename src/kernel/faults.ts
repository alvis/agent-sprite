import { InteractionExit } from './navigation';
import { redactResolved } from './redaction';

/** structured error returned by the core dispatcher, including incomplete resources */
export type CommandErrorCode =
  | 'USAGE'
  | 'INPUT'
  | 'AUTH'
  | 'PREFLIGHT'
  | 'CONFLICT'
  | 'PROVIDER'
  | 'CANCELLED'
  | 'UNEXPECTED';

/** provider-neutral failure classes every provider maps its SDK errors onto */
export type ProviderErrorCode =
  | 'authentication'
  | 'not-found'
  | 'ownership-mismatch'
  | 'conflict'
  | 'transient'
  | 'failed';

/** provider-neutral failure surfaced instead of a provider SDK error */
export interface ProviderFailure extends Error {
  /** neutral failure class */
  code: ProviderErrorCode;
}

/** expected fault identity and diagnostic cause */
export interface CommandFaultParams extends ErrorOptions {
  code: CommandErrorCode;
  message: string;
  causeVisibility?: 'public' | 'private';
  /** every individual problem, reported together beside the message */
  details?: readonly string[];
}

/** cleanup failures retained beside an operation's original failure */
export interface RecoveryState {
  originalCause: unknown;
  failures: Error[];
  details: string[];
}

/** original failure and one recovery failure to retain beside it */
export interface RetainRecoveryFailureParams {
  primary: unknown;
  step: string;
  failure: unknown;
}

const UNAUTHENTICATED_STATUS = 401;
const ACCESS_DENIED_STATUS = 403;
const CONFLICT_STATUS = 409;
const diagnosticLimit = 256;
export const diagnosticCount = 6;

const recoveryState = new WeakMap<Error, RecoveryState>();

/**
 * reads the cleanup failures retained on an operation error
 * @param error operation failure
 * @returns retained recovery state, if any
 */
export function recoveryOf(error: Error): RecoveryState | undefined {
  return recoveryState.get(error);
}

/**
 * retains a cleanup failure on the original operation error
 * @param params original failure, recovery step and secondary failure
 * @param params.primary original failure
 * @param params.step cleanup action whose failure is retained
 * @param params.failure secondary failure
 * @returns original Error identity with bounded details
 */
export function retainRecoveryFailure({
  primary,
  step,
  failure,
}: RetainRecoveryFailureParams): Error {
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
 * redacts and bounds one public diagnostic
 * @param value untrusted diagnostic text
 * @returns safe one-line detail
 */
export function safeDiagnostic(value: string): string {
  return redactResolved(value)
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, diagnosticLimit);
}

/** expected domain failure with an explicit D10 category */
export class CommandFault extends Error {
  public readonly code: CommandErrorCode;
  public readonly causeVisibility: 'public' | 'private';
  public readonly details: readonly string[];

  /**
   * retains the machine-readable category and original failure
   * @param params D10 category, actionable diagnostic, and original failure
   * @param params.code D10 failure category
   * @param params.message actionable diagnostic
   * @param params.cause original rejection when wrapping a failure
   * @param params.causeVisibility whether the cause can appear in public details
   * @param params.details every individual problem, reported together
   */
  constructor({
    code,
    message,
    cause,
    causeVisibility = 'public',
    details = [],
  }: CommandFaultParams) {
    super(message, { cause });
    this.name = 'CommandFault';
    this.code = code;
    this.causeVisibility = causeVisibility;
    this.details = details;
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
 * identifies a user cancellation, distinct from back navigation and failures
 * @param error caught failure
 * @returns whether the user cancelled the operation
 */
export function isCancellation(error: unknown): boolean {
  return error instanceof InteractionExit && error.action === 'cancel';
}

/**
 * categorizes HTTP failures independently of diagnostic text
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
