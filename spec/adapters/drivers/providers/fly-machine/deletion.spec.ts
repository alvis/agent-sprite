import { describe, expect, it, vi } from 'vitest';

import { FlyApi } from '#adapters/drivers/providers/fly-machine/api';
import { waitUntilDeleted } from '#adapters/drivers/providers/fly-machine/deletion';
import { InteractionExit } from '#kernel/navigation';
import { OperationContext, withOperation } from '#kernel/operation';

const http = {
  fetch: vi.fn<typeof fetch>(async () =>
    Response.json({
      id: 'app-1',
      name: 'alpha',
      internal_numeric_id: 1,
      organization: { slug: 'team' },
    }),
  ),
} satisfies Partial<typeof globalThis>;

describe('fn:waitUntilDeleted', () => {
  it('should report an app that remains present at the deletion deadline', async () => {
    vi.stubGlobal('fetch', http.fetch);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 120_000;

      return now;
    });

    await expect(
      waitUntilDeleted(new FlyApi('test-token'), 'alpha'),
    ).rejects.toMatchObject({
      code: 'transient',
      message: expect.stringContaining('alpha'),
    });
  });

  it('should preserve caller cancellation while checking deletion', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', http.fetch);
    http.fetch.mockImplementationOnce(async () => {
      controller.abort();

      return Response.json({});
    });

    await expect(
      withOperation(
        new OperationContext({ signal: controller.signal }),
        async () => waitUntilDeleted(new FlyApi('test-token'), 'alpha'),
      ),
    ).rejects.toEqual(new InteractionExit('cancel'));
  });
});
