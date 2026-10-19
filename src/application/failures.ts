import {
  CommandFault,
  diagnosticCount,
  ensureError,
  isCancellation,
  recoveryOf,
  safeDiagnostic,
} from '#kernel/faults';
import { ProviderFault } from '#kernel/provider-fault';

import type {
  CommandErrorCode,
  ProviderErrorCode,
  RecoveryState,
} from '#kernel/faults';

/** structured failure and recoverable resource identity */
export interface CommandError {
  code: CommandErrorCode;
  message: string;
  machine?: string;
  machineId?: string;
  setupIncomplete?: boolean;
  details?: string[];
  outcome?: 'retained' | 'absent' | 'unknown';
}

const PROVIDER_FAILURE_CODES: Readonly<
  Record<ProviderErrorCode, CommandErrorCode>
> = {
  'authentication': 'AUTH',
  'not-found': 'PROVIDER',
  'ownership-mismatch': 'CONFLICT',
  'conflict': 'CONFLICT',
  'transient': 'PROVIDER',
  'failed': 'PROVIDER',
};

/**
 * maps typed domain and provider failures without interpreting message strings
 * @param exception caught failure
 * @returns safe D10 error details
 */
export function commandError(exception: unknown): CommandError {
  const error = ensureError(exception);
  const code = errorCode(error);
  const state = recoveryOf(error);
  const details = [
    ...(error instanceof CommandFault ? error.details.map(safeDiagnostic) : []),
    ...[...(state?.details ?? []), ...publicCauseDetails(error, state)].slice(
      0,
      diagnosticCount,
    ),
  ];

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
 * maps known error identities while leaving unclassified failures unexpected
 * @param error normalized JavaScript error
 * @returns one D10 category
 */
function errorCode(error: Error): CommandErrorCode {
  if (error instanceof CommandFault) {
    return error.code;
  }
  if (isCancellation(error)) {
    return 'CANCELLED';
  }
  if (error instanceof ProviderFault) {
    return PROVIDER_FAILURE_CODES[error.code];
  }

  return 'UNEXPECTED';
}
