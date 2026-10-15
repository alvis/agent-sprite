import { CommandFault } from '#errors';

import type { GuestCommandResult } from '../types.js';

const commandResultFieldCount = 3;

/** private requests executed by the actual guest lock owner */
export type TransactionRequest =
  | {
      type: 'run';
      argv: readonly string[];
      input?: string;
      env?: Record<string, string>;
    }
  | { type: 'read' | 'exists' | 'remove'; path: string }
  | {
      type: 'write';
      path: string;
      contents: string;
      mode: number;
      removeOnRelease?: boolean;
    };

/** resolver retained only until the guest acknowledges actual settlement */
export interface PendingRequest {
  accepted: boolean;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * validates the private command result before exposing it to host decisions
 * @param result acknowledged guest result
 * @returns actual guest output and exit status
 */
export function transactionCommandResult(result: unknown): GuestCommandResult {
  if (
    !isTransactionRecord(result) ||
    Object.keys(result).length !== commandResultFieldCount ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    typeof result.exitCode !== 'number' ||
    !Number.isInteger(result.exitCode)
  ) {
    throw unresolvedTransaction();
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * reports uncertainty without including private command or filesystem data
 * @param cause bounded public diagnostic with any original cause kept private
 * @returns typed provider failure retaining the pending-work limitation
 */
export function unresolvedTransaction(cause?: Error): CommandFault {
  return new CommandFault({
    code: 'PROVIDER',
    message:
      'Guest transaction acknowledgement unavailable; pending remote work may be unfinished.',
    cause,
  });
}

/**
 * narrows untrusted protocol objects before reading their fields
 * @param value parsed frame or result
 * @returns whether the value is a non-array object
 */
export function isTransactionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * bounds acknowledgement waiting while leaving accepted guest work alive
 * @param pending explicit guest acknowledgement
 * @param timeoutMs host waiting deadline
 * @param stop stops future request admission without killing accepted work
 * @returns acknowledged value
 */
export async function waitForTransaction<T>(
  pending: Promise<T>,
  timeoutMs: number,
  stop: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(unresolvedTransaction());
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * requires exactly one completion outcome before touching a pending request
 * @param event parsed guest settlement frame
 */
export function assertTransactionSettlement(
  event: Record<string, unknown>,
): void {
  const hasFailure = Object.hasOwn(event, 'failure');
  const hasResult = Object.hasOwn(event, 'result');
  if (
    hasFailure === hasResult ||
    (hasFailure && typeof event.failure !== 'string')
  ) {
    throw unresolvedTransaction();
  }
}

/**
 * validates the exact worker read result before exposing its contents
 * @param result untrusted guest result
 * @returns acknowledged file contents
 */
export function transactionReadResult(result: unknown): string {
  if (
    !isTransactionRecord(result) ||
    Object.keys(result).length !== 1 ||
    typeof result.contents !== 'string'
  ) {
    throw unresolvedTransaction();
  }

  return result.contents;
}

/**
 * validates the exact worker existence result before exposing its value
 * @param result untrusted guest result
 * @returns acknowledged path existence
 */
export function transactionExistsResult(result: unknown): boolean {
  if (
    !isTransactionRecord(result) ||
    Object.keys(result).length !== 1 ||
    typeof result.exists !== 'boolean'
  ) {
    throw unresolvedTransaction();
  }

  return result.exists;
}

/**
 * validates the empty success record emitted by guest filesystem mutations
 * @param result untrusted guest result
 */
export function transactionMutationResult(result: unknown): void {
  if (!isTransactionRecord(result) || Object.keys(result).length !== 0) {
    throw unresolvedTransaction();
  }
}
