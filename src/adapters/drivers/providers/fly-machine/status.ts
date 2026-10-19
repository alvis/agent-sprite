import { ProviderFault } from '#kernel/provider-fault';

import type { ProviderErrorCode } from '#kernel/faults';
import type { ProviderFaultParams } from '#kernel/provider-fault';

const UNAUTHENTICATED_STATUS = 401;
const ACCESS_DENIED_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const RATE_LIMITED_STATUS = 429;
const SERVER_ERROR_STATUS = 500;
const DIAGNOSTIC_LENGTH = 300;

/** a Machines API refusal that keeps the HTTP status it came with */
export class FlyApiFault extends ProviderFault {
  public readonly status: number;

  /**
   * records the status beside the neutral class and the API's diagnostic
   * @param params failure class, diagnostic and the HTTP status
   * @param params.status HTTP status the API answered with
   */
  constructor(params: ProviderFaultParams & { status: number }) {
    super(params);
    this.name = 'FlyApiFault';
    this.status = params.status;
  }
}

/**
 * tells whether a rejection is the API reporting a missing resource
 * @param error caught rejection
 * @returns true for a not-found failure
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ProviderFault && error.code === 'not-found';
}

/**
 * tells whether a rejection is the API refusing access to a resource; it also
 * answers 403 for an app name another organization owns
 * @param error caught rejection
 * @returns true for a 403 refusal
 */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof FlyApiFault && error.status === ACCESS_DENIED_STATUS;
}

/**
 * classifies an HTTP status independently of diagnostic text
 * @param status observed HTTP status
 * @returns neutral failure class
 */
export function statusFailureCode(status: number): ProviderErrorCode {
  switch (status) {
    case UNAUTHENTICATED_STATUS:
    case ACCESS_DENIED_STATUS:
      return 'authentication';
    case NOT_FOUND_STATUS:
      return 'not-found';
    case CONFLICT_STATUS:
      return 'conflict';
    default:
      return status === RATE_LIMITED_STATUS || status >= SERVER_ERROR_STATUS
        ? 'transient'
        : 'failed';
  }
}

/**
 * keeps the API's own error text short and on one line
 * @param text response body
 * @returns bounded diagnostic
 */
export function diagnostic(text: string): string {
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'string'
    ) {
      message = parsed.error;
    }
  } catch {
    // a non-JSON body is reported as it is
  }

  return message.replace(/\s+/gu, ' ').trim().slice(0, DIAGNOSTIC_LENGTH);
}
