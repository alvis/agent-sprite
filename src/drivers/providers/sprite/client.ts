import { SpritesClient } from '@fly/sprites';

import { currentOperation } from '#operation';

/** bounds every Sprites API request independently of command cancellation */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * binds a Sprites API token to a client whose requests end when the command is
 * cancelled, not only when the SDK's own timeout elapses
 * @param credential Sprites API token
 * @returns an SDK client whose requests also end on cancellation
 */
export function createSpritesClient(credential: string): SpritesClient {
  const client = new SpritesClient(credential, { timeout: REQUEST_TIMEOUT_MS });

  // the SDK routes every client request through this member and accepts no caller signal
  return Object.assign(client, { fetch: cancellableFetch });
}

/**
 * issues one request that also aborts with the current command's signal,
 * failing the way the SDK's own request wrapper does
 * @param url request URL
 * @param init request settings, carrying the SDK's timeout signal
 * @returns the response
 */
async function cancellableFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const signals = [init.signal, currentOperation()?.signal].filter(
    (signal): signal is AbortSignal => signal instanceof AbortSignal,
  );
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Network error: ${error.message}`, { cause: error });
    }
    throw error;
  }
}
