import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpritesClient } from '#adapters/drivers/providers/sprite/client';
import { OperationContext, withOperation } from '#kernel/operation';

/**
 * replaces the network with a request that never answers until its signal aborts
 * @returns the signals each request was issued with
 */
function hangingNetwork(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
    const { signal } = init;
    if (signal) {
      signals.push(signal);
    }

    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(new Error('aborted', { cause: signal.reason })),
        {
          once: true,
        },
      );
    });
  });

  return signals;
}

describe('fn:createSpritesClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should abort a hung request as soon as the command is cancelled', async () => {
    const signals = hangingNetwork();
    const controller = new AbortController();
    const operation = new OperationContext({ signal: controller.signal });
    const client = createSpritesClient('sdk-only-cancellable');

    const pending = withOperation(operation, async () =>
      client.getSprite('hung'),
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toThrow(/^Network error: /u);
    expect(signals[0]?.aborted).toBe(true);
  });
});
