import { describe, expect, it, vi } from 'vitest';

import { flyRequest } from '#adapters/drivers/providers/fly-machine/transport';
import { InteractionExit } from '#kernel/navigation';
import { OperationContext, withOperation } from '#kernel/operation';

function refused(retryAfter: string): Response {
  return new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429,
    headers: { 'retry-after': retryAfter },
  });
}

describe('Fly request transport', () => {
  it('should report a failed connection as a transient provider fault without repeating a write', async () => {
    const failure = new Error('offline');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw failure;
    });
    vi.stubGlobal('fetch', fetch);

    await expect(
      flyRequest('FlyV1 token', { method: 'POST', path: '/apps' }),
    ).rejects.toMatchObject({ code: 'transient', cause: failure });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should preserve caller cancellation while a request is in flight', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();

      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetch);
    const operation = new OperationContext({ signal: controller.signal });

    await expect(
      withOperation(operation, async () =>
        flyRequest('FlyV1 token', { method: 'POST', path: '/apps' }),
      ),
    ).rejects.toEqual(new InteractionExit('cancel'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['seconds', 'future HTTP date'])(
    'should hold a rate-limited retry for the requested %s',
    async (format) => {
      const retryAfter =
        format === 'seconds' ? '5' : new Date(Date.now() + 5_000).toUTCString();
      const controller = new AbortController();
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        refused(retryAfter),
      );
      vi.stubGlobal('fetch', fetch);
      const operation = new OperationContext({ signal: controller.signal });
      const cancel = setTimeout(() => controller.abort(), 1_200);

      try {
        await expect(
          withOperation(operation, async () =>
            flyRequest('FlyV1 token', { method: 'POST', path: '/apps' }),
          ),
        ).rejects.toEqual(new InteractionExit('cancel'));
      } finally {
        clearTimeout(cancel);
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('should use its bounded default retry after an unreadable header', async () => {
    const controller = new AbortController();
    const replies = [refused('not a date'), new Response('{"accepted":true}')];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => replies.shift()!);
    vi.stubGlobal('fetch', fetch);
    const operation = new OperationContext({ signal: controller.signal });
    const cancel = setTimeout(() => controller.abort(), 1_200);

    try {
      await expect(
        withOperation(operation, async () =>
          flyRequest('FlyV1 token', { method: 'POST', path: '/apps' }),
        ),
      ).resolves.toEqual({ accepted: true });
    } finally {
      clearTimeout(cancel);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
