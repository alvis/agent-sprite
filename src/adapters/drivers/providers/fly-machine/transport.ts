import { setTimeout as delay } from 'node:timers/promises';

import { operationSignal, runOperation } from '#kernel/operation';
import { ProviderFault } from '#kernel/provider-fault';

import { withExecGate } from './exec-gate';
import { diagnostic, FlyApiFault, statusFailureCode } from './status';

/** one Machines API request */
export interface FlyRequest {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** path relative to the API base, starting with a slash */
  path: string;
  /** JSON body, when the request carries one */
  body?: unknown;
  /** transport timeout; the default applies when absent */
  timeoutMs?: number;
}

/** one attempt's outcome */
type Attempt =
  | { ok: true; body: unknown }
  | {
      ok: false;
      fault: ProviderFault;
      retryAfterMs: number | undefined;
      /** the API refused the request for its rate before acting on it */
      isRateLimited: boolean;
    };

const API_BASE = 'https://api.machines.dev/v1';
const API_TIMEOUT_MS = 30_000;
const NO_CONTENT_STATUS = 204;
/** a read is tried this often in all before a transient failure is reported */
const READ_ATTEMPTS = 4;
/**
 * a request the API refuses for its rate is tried this often in all; the
 * refusal comes before the API acts, so even a write is safe to repeat, and
 * a burst of guest commands refills the rate within seconds
 */
const RATE_LIMIT_ATTEMPTS = 6;
const RATE_LIMITED_STATUS = 429;
const RETRY_BASE_MS = 500;
/** no wait between attempts exceeds this, whatever the API asks for */
const RETRY_LIMIT_MS = 8_000;
const MILLISECONDS_PER_SECOND = 1_000;
const RETRY_SECONDS = /^\d+$/u;

/**
 * sends one request, retrying a read whose failure is transient with a
 * bounded exponential backoff that honours Retry-After; a write is sent once,
 * because repeating it could act twice, unless the API refused it for its
 * rate, which happens before the API acts
 * @param authorization Authorization header value
 * @param request method, path, body and timeout
 * @returns the decoded body, or undefined for an empty one
 */
export async function flyRequest(
  authorization: string,
  request: FlyRequest,
): Promise<unknown> {
  return withExecGate(request.path, async () =>
    sendWithRetries(authorization, request),
  );
}

/**
 * sends one request and repeats it as its failure allows
 * @param authorization Authorization header value
 * @param request method, path, body and timeout
 * @returns the decoded body, or undefined for an empty one
 */
async function sendWithRetries(
  authorization: string,
  request: FlyRequest,
): Promise<unknown> {
  const attempts = request.method === 'GET' ? READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await attemptRequest(authorization, request);
    if (outcome.ok) {
      return outcome.body;
    }
    const allowed = outcome.isRateLimited
      ? Math.max(attempts, RATE_LIMIT_ATTEMPTS)
      : attempts;
    if (attempt >= allowed || outcome.fault.code !== 'transient') {
      throw outcome.fault;
    }
    const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
    await runOperation(async () =>
      delay(Math.min(outcome.retryAfterMs ?? backoff, RETRY_LIMIT_MS)),
    );
  }
}

/**
 * sends one bounded request and maps a refusal onto a neutral failure
 * @param authorization Authorization header value
 * @param request method, path, body and timeout
 * @returns the decoded body, or the failure with any requested wait
 */
async function attemptRequest(
  authorization: string,
  request: FlyRequest,
): Promise<Attempt> {
  const { method, path, body, timeoutMs = API_TIMEOUT_MS } = request;
  const route = `${method} ${path.split('?')[0]}`;
  let response: Response;
  try {
    response = await runOperation(async () =>
      fetch(new URL(`${API_BASE}${path}`), {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: JSON.stringify(body),
        signal: operationSignal(timeoutMs),
      }).catch((error: unknown) => {
        throw new ProviderFault({
          code: 'transient',
          message: `Fly Machines API ${route} could not be reached: ${(error as Error).message}`,
          cause: error,
        });
      }),
    );
  } catch (error) {
    // a cancelled operation surfaces as its own reason, never as a fault
    if (error instanceof ProviderFault) {
      return {
        ok: false,
        fault: error,
        retryAfterMs: undefined,
        isRateLimited: false,
      };
    }
    throw error;
  }
  const text = await runOperation(async () => response.text());
  if (!response.ok) {
    return {
      ok: false,
      fault: new FlyApiFault({
        code: statusFailureCode(response.status),
        message: `Fly Machines API ${route} returned ${response.status}: ${diagnostic(text)}`,
        status: response.status,
      }),
      retryAfterMs: retryAfter(response.headers.get('retry-after')),
      isRateLimited: response.status === RATE_LIMITED_STATUS,
    };
  }

  return { ok: true, body: decode(route, response.status, text) };
}

/**
 * decodes a successful body
 * @param route method and path, for the diagnostic
 * @param status HTTP status
 * @param text response body
 * @returns the decoded JSON, or undefined for an empty body
 */
function decode(route: string, status: number, text: string): unknown {
  if (status === NO_CONTENT_STATUS || text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderFault({
      code: 'failed',
      message: `Fly Machines API ${route} returned a body that is not JSON: ${diagnostic(text)}`,
      cause: error,
    });
  }
}

/**
 * reads how long the API asks a client to wait
 * @param header Retry-After value, in seconds or as an HTTP date
 * @returns the wait in milliseconds, or undefined when absent or unreadable
 */
function retryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  if (RETRY_SECONDS.test(header.trim())) {
    return Number(header.trim()) * MILLISECONDS_PER_SECOND;
  }
  const at = Date.parse(header);

  return Number.isNaN(at) ? undefined : Math.max(at - Date.now(), 0);
}
