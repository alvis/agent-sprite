import { ServiceLogStream, Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  consumeServiceStream,
  openServiceStream,
  waitForService,
} from '#adapters/drivers/providers/sprite/services/stream';
import { OperationContext, withOperation } from '#kernel/operation';

import type { ServiceLogEvent } from '@fly/sprites';

const stopped = Object.assign(
  new Sprite('stopped', new SpritesClient('offline-test')),
  {
    getService: vi.fn<Sprite['getService']>(async (name) => ({
      name,
      cmd: '/bin/worker',
      args: [],
      needs: [],
    })),
  } satisfies Partial<Sprite>,
);

describe('fn:openServiceStream', () => {
  it('should close a late SDK stream after its invocation ends', async () => {
    const pending = Promise.withResolvers<ServiceLogStream>();
    const controller = new AbortController();
    const operation = new OperationContext({ signal: controller.signal });
    const stream = new ServiceLogStream(new Response(''));
    const close = vi.spyOn(stream, 'close');
    const opening = withOperation(operation, async () =>
      openServiceStream(async () => pending.promise),
    );
    const rejected = expect(opening).rejects.toMatchObject({
      action: 'cancel',
    });

    controller.abort();
    await rejected;
    pending.resolve(stream);

    await vi.waitFor(() => expect(close.mock.calls).toEqual([[]]));
  });
});

describe('fn:consumeServiceStream', () => {
  it('should close a pending stream when the caller cancels', async () => {
    const controller = new AbortController();
    const stream = new ServiceLogStream(new Response(new ReadableStream()));
    const close = vi.spyOn(stream, 'close');
    const events = vi.fn<(event: ServiceLogEvent) => void>();
    const consuming = withOperation(
      new OperationContext({ signal: controller.signal }),
      async () => consumeServiceStream(stream, events),
    );
    const rejected = expect(consuming).rejects.toMatchObject({
      action: 'cancel',
    });

    controller.abort();
    await rejected;

    expect(close).toHaveBeenCalled();
    expect(events.mock.calls).toEqual([]);
  });
});

describe('fn:waitForService', () => {
  it('should fail when a service never reports running before its deadline', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(31_000);

    await expect(waitForService(stopped, 'worker')).rejects.toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('worker'),
    });
  });
});
