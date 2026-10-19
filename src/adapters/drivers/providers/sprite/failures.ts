import { APIError, ExecError, FilesystemError } from '@fly/sprites';

import { ProviderFault } from '#kernel/provider-fault';

import type { ProviderErrorCode } from '#kernel/faults';

const UNAUTHENTICATED_STATUS = 401;
const ACCESS_DENIED_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const RATE_LIMITED_STATUS = 429;
const SERVER_ERROR_STATUS = 500;

/**
 * runs one Sprites SDK call and surfaces its typed SDK failures as neutral
 * provider failures; untyped rejections, including cancellation, pass unchanged
 * @param action SDK call
 * @returns the call's result
 */
export async function callSprites<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toProviderFailure(error);
  }
}

/**
 * converts one typed SDK failure, keeping its message so diagnostics are unchanged
 * @param error caught rejection
 * @returns the neutral failure, or the original rejection when it is not an SDK error
 */
export function toProviderFailure(error: unknown): unknown {
  if (error instanceof APIError) {
    return new ProviderFault({
      code: statusFailureCode(error.statusCode),
      message: error.message,
      cause: error.cause,
    });
  }
  if (error instanceof ExecError || error instanceof FilesystemError) {
    return new ProviderFault({
      code: 'failed',
      message: error.message,
      cause: error.cause,
    });
  }

  return error;
}

/**
 * tells whether a rejection is the provider reporting that a Sprite is absent
 * @param error caught rejection from a direct SDK call
 * @returns true for an HTTP 404 SDK failure
 */
export function isSpriteAbsent(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === NOT_FOUND_STATUS;
}

/**
 * classifies an HTTP status independently of diagnostic text
 * @param status observed provider HTTP status
 * @returns neutral failure class
 */
function statusFailureCode(status: number | undefined): ProviderErrorCode {
  switch (status) {
    case UNAUTHENTICATED_STATUS:
    case ACCESS_DENIED_STATUS:
      return 'authentication';
    case NOT_FOUND_STATUS:
      return 'not-found';
    case CONFLICT_STATUS:
      return 'conflict';
    default:
      return status === RATE_LIMITED_STATUS ||
        (status !== undefined && status >= SERVER_ERROR_STATUS)
        ? 'transient'
        : 'failed';
  }
}
