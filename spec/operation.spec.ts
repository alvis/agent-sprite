import { setTimeout as delay } from 'node:timers/promises';

import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#errors';
import {
  createManagedSprite,
  deleteManagedSprite,
  listManagedSprites,
  MANAGED_LABEL,
  SCHEMA_LABEL,
} from '#integrations/sprites';
import {
  OperationContext,
  checkOperation,
  currentOperation,
  recoverOperation,
  runBoundedIO,
  runOperation,
  traceStage,
  withOperation,
} from '#operation';

import type { StageEvent } from '#operation';

/** One caller-controlled SDK settlement without a workflow replacement. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, resolve, reject };
}

describe('invocation-scoped operations', () => {
  it('should report ordered real stage timings only to the originating invocation', async () => {
    const firstEvents: StageEvent[] = [];
    const secondEvents: StageEvent[] = [];
    const first = new OperationContext({
      signal: new AbortController().signal,
      onStage: (event) => firstEvents.push(event),
    });
    const second = new OperationContext({
      signal: new AbortController().signal,
      onStage: (event) => secondEvents.push(event),
    });
    const firstClient = new SpritesClient('sdk-only-stage-first');
    const secondClient = new SpritesClient('sdk-only-stage-second');

    vi.spyOn(firstClient, 'listAllSprites').mockImplementation(async () => {
      await delay(2);

      return [];
    });
    vi.spyOn(secondClient, 'listAllSprites').mockResolvedValue([]);

    await Promise.all([
      withOperation(first, async () => {
        first.select('list');
        first.identify({ name: 'first' });

        return traceStage('command', async () =>
          listManagedSprites(firstClient),
        );
      }),
      withOperation(second, async () => {
        second.select('doctor');

        return traceStage('command', async () =>
          listManagedSprites(secondClient),
        );
      }),
    ]);

    expect(firstEvents.map(({ event }) => event)).toEqual([
      'start',
      'complete',
    ]);
    expect(secondEvents.map(({ event }) => event)).toEqual([
      'start',
      'complete',
    ]);
    expect(firstEvents).toMatchObject([
      { command: 'list', targetKnown: true, stage: 'command' },
      { command: 'list', targetKnown: true, stage: 'command', outcome: 'ok' },
    ]);
    expect(secondEvents).toMatchObject([
      { command: 'doctor', targetKnown: false, stage: 'command' },
      {
        command: 'doctor',
        targetKnown: false,
        stage: 'command',
        outcome: 'ok',
      },
    ]);
    expect(firstEvents[1]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(secondEvents[1]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(firstEvents[0]).not.toHaveProperty('durationMs');
    expect(secondEvents[0]).not.toHaveProperty('durationMs');
  });

  it('should stop stage diagnostics and SDK effects after the originating invocation closes', async () => {
    const events: StageEvent[] = [];
    const context = new OperationContext({
      signal: new AbortController().signal,
      onStage: (event) => events.push(event),
    });
    const gate = deferred<void>();
    const client = new SpritesClient('sdk-only-late-stage');
    const sdkCall = vi.spyOn(client, 'listAllSprites');
    let pending!: Promise<unknown>;

    await withOperation(context, async () => {
      pending = traceStage('command', async () => {
        await gate.promise;

        return listManagedSprites(client);
      }).catch((error: unknown) => error);
      expect(events.map(({ event }) => event)).toEqual(['start']);
    });
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ action: 'cancel' });
    expect(context.closed).toBe(true);
    expect(sdkCall).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).toEqual(['start']);

    const afterClose = await traceStage(
      'command',
      async () => listManagedSprites(client),
      context,
    ).catch((error: unknown) => error);
    expect(afterClose).toMatchObject({ action: 'cancel' });
    expect(sdkCall).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).toEqual(['start']);
  });

  it('should isolate overlapping SDK calls when only one invocation is cancelled', async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstContext = new OperationContext({
      signal: firstController.signal,
    });
    const secondContext = new OperationContext({
      signal: secondController.signal,
    });
    const firstPending = deferred<Sprite[]>();
    const secondPending = deferred<Sprite[]>();
    const firstClient = new SpritesClient('sdk-only-first-token');
    const secondClient = new SpritesClient('sdk-only-second-token');
    vi.spyOn(firstClient, 'listAllSprites').mockReturnValue(
      firstPending.promise,
    );
    vi.spyOn(secondClient, 'listAllSprites').mockReturnValue(
      secondPending.promise,
    );

    const first = withOperation(firstContext, async () => {
      expect(currentOperation()).toBe(firstContext);

      return listManagedSprites(firstClient);
    });
    const second = withOperation(secondContext, async () => {
      expect(currentOperation()).toBe(secondContext);

      return listManagedSprites(secondClient);
    });
    firstController.abort();
    secondPending.resolve([]);

    await expect(first).rejects.toMatchObject({ action: 'cancel' });
    await expect(second).resolves.toEqual([]);
    expect(firstContext.closed).toBe(true);
    expect(secondContext.closed).toBe(true);
    expect(currentOperation()).toBeUndefined();
    firstPending.resolve([]);
    await Promise.resolve();
  });

  it('should use independent recovery and restores the cancelled parent scope', async () => {
    const controller = new AbortController();
    const parent = new OperationContext({ signal: controller.signal });
    const observations = await withOperation(parent, async () => {
      controller.abort();
      const recovered = await recoverOperation(async () => {
        const recovery = currentOperation();
        expect(recovery).toBeDefined();
        expect(recovery).not.toBe(parent);
        checkOperation();

        return { parentSignalAborted: parent.signal.aborted, recovery };
      });

      expect(currentOperation()).toBe(parent);
      expect(recovered.recovery?.closed).toBe(true);

      return recovered.parentSignalAborted;
    });

    expect(observations).toBe(true);
    expect(parent.closed).toBe(true);
  });

  it('should refuse late descendant IO and recovery after its owner closes', async () => {
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const release = deferred<void>();
    let descendant!: Promise<unknown>;
    const sdkCall = vi.fn(async () => []);

    await withOperation(context, async () => {
      descendant = release.promise.then(async () => {
        await expect(runOperation(sdkCall)).rejects.toMatchObject({
          action: 'cancel',
        });
        await expect(
          recoverOperation(async () => 'late'),
        ).rejects.toMatchObject({ action: 'cancel' });
      });
    });
    release.resolve();
    await descendant;

    expect(context.closed).toBe(true);
    expect(sdkCall).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'should observe late SDK %s without changing another invocation',
    async (settlement) => {
      const cancelled = new AbortController();
      const firstContext = new OperationContext({ signal: cancelled.signal });
      const pending = deferred<Sprite[]>();
      const client = new SpritesClient('sdk-only-late-token');
      vi.spyOn(client, 'listAllSprites').mockReturnValue(pending.promise);
      const first = withOperation(firstContext, async () =>
        listManagedSprites(client),
      );

      cancelled.abort();
      await expect(first).rejects.toMatchObject({ action: 'cancel' });

      const other = new OperationContext({
        signal: new AbortController().signal,
      });
      const result = await withOperation(other, async () => {
        expect(currentOperation()).toBe(other);
        if (settlement === 'resolve') {
          pending.resolve([]);
        } else {
          pending.reject(new Error('late provider failure'));
        }

        return runOperation(async () => 'second invocation continued');
      });

      expect(result).toBe('second invocation continued');
      expect(firstContext.closed).toBe(true);
      expect(other.closed).toBe(true);
    },
  );

  it('should allow direct unscoped SDK helpers and accepts an explicitly scoped direct caller', async () => {
    const client = new SpritesClient('sdk-only-direct-token');
    const sprite = Object.assign(new Sprite('disposable', client), {
      labels: [MANAGED_LABEL],
    });
    vi.spyOn(client, 'listAllSprites').mockResolvedValue([sprite]);
    const unscoped = await listManagedSprites(client);
    const context = new OperationContext({
      signal: new AbortController().signal,
    });
    const scoped = await withOperation(context, async () =>
      listManagedSprites(client),
    );

    expect(unscoped).toEqual([sprite]);
    expect(scoped).toEqual([sprite]);
    expect(context.closed).toBe(true);
    expect(client.listAllSprites).toHaveBeenCalledTimes(2);
  });

  it('should keep deadline expiry distinct from a user cancellation', () => {
    const timeout = new AbortController();
    timeout.abort(new DOMException('operation deadline', 'TimeoutError'));
    const context = new OperationContext({ signal: timeout.signal });

    expect(() => checkOperation(context)).toThrowError(DOMException);
    try {
      checkOperation(context);
    } catch (error) {
      expect(error).toMatchObject({ name: 'TimeoutError' });
      expect(commandError(error).code).not.toBe('CANCELLED');
    }
  });

  it('should bound unsupported IO with a timeout that is distinct from cancellation', async () => {
    vi.useFakeTimers();
    try {
      const context = new OperationContext({
        signal: new AbortController().signal,
      });
      const pending = deferred<string>();
      const effect = vi.fn(async (_signal?: AbortSignal) => pending.promise);
      const result = withOperation(context, async () => runBoundedIO(effect));
      const observed = result.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(30_000);
      const error: unknown = await observed;

      expect(error).toMatchObject({ name: 'TimeoutError' });
      expect(commandError(error).code).not.toBe('CANCELLED');
      expect(effect).toHaveBeenCalledOnce();
      expect(effect.mock.calls[0]?.[0]?.aborted).toBe(true);
      pending.resolve('late remote completion');
      expect(context.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not start an SDK call when its invocation is already cancelled', async () => {
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const client = new SpritesClient('sdk-only-pre-abort-token');
    const list = vi.spyOn(client, 'listAllSprites');
    controller.abort();

    await expect(
      withOperation(context, async () => listManagedSprites(client)),
    ).rejects.toMatchObject({
      action: 'cancel',
    });

    expect(list).not.toHaveBeenCalled();
    expect(context.closed).toBe(true);
  });

  it('should stop deletion when cancellation arrives after the awaited provider lookup', async () => {
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const client = new SpritesClient('sdk-only-delete-token');
    const sprite = Object.assign(new Sprite('disposable', client), {
      id: 'exact-id',
      organizationName: 'isolated-organization',
      labels: [MANAGED_LABEL],
    });
    const lookup = vi
      .spyOn(client, 'getSprite')
      .mockImplementation(async () => {
        controller.abort();

        return sprite;
      });
    const remove = vi.spyOn(client, 'deleteSprite');

    await expect(
      withOperation(context, async () =>
        deleteManagedSprite(client, {
          name: sprite.name,
          expectedId: sprite.id,
          expectedOrganization: sprite.organizationName,
        }),
      ),
    ).rejects.toMatchObject({ action: 'cancel' });

    expect(lookup).toHaveBeenCalledExactlyOnceWith(sprite.name);
    expect(remove).not.toHaveBeenCalled();
  });

  it('should wait for create settlement before reporting exact retained identity', async () => {
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const client = new SpritesClient('sdk-only-create-token');
    const sprite = Object.assign(new Sprite('disposable', client), {
      id: 'exact-created-id',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
    });
    const pending = deferred<Sprite>();
    const create = vi
      .spyOn(client, 'createSprite')
      .mockReturnValue(pending.promise);
    const reconcile = vi.spyOn(client, 'getSprite');
    const result = withOperation(context, async () =>
      createManagedSprite(client, sprite.name),
    );

    controller.abort();
    await Promise.resolve();
    expect(create).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(context.target).toEqual({ name: sprite.name });

    pending.resolve(sprite);
    await expect(result).resolves.toBe(sprite);
    expect(context.target).toEqual({ name: sprite.name, id: sprite.id });
    expect(reconcile).not.toHaveBeenCalled();
    expect(context.closed).toBe(true);
  });

  it('should reconcile a failed create only after settlement in an independent scope', async () => {
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const client = new SpritesClient('sdk-only-reconcile-token');
    const pending = deferred<Sprite>();
    vi.spyOn(client, 'createSprite').mockReturnValue(pending.promise);
    const sprite = Object.assign(new Sprite('disposable', client), {
      id: 'retained-id',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
    });
    const reconcile = vi
      .spyOn(client, 'getSprite')
      .mockImplementation(async () => {
        expect(currentOperation()).not.toBe(context);
        checkOperation();

        return sprite;
      });
    const result = withOperation(context, async () =>
      createManagedSprite(client, sprite.name),
    );

    controller.abort();
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
    pending.reject(new Error('provider settled after cancel'));

    await expect(result).rejects.toMatchObject({
      machine: sprite.name,
      machineId: sprite.id,
      outcome: 'retained',
      setupIncomplete: true,
    });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(sprite.name);
    expect(context.target).toEqual({ name: sprite.name });
  });

  it('should report unresolved failed create without inventing provider identity', async () => {
    const client = new SpritesClient('sdk-only-unresolved-token');
    const pending = deferred<Sprite>();
    vi.spyOn(client, 'createSprite').mockReturnValue(pending.promise);
    const reconcile = vi
      .spyOn(client, 'getSprite')
      .mockRejectedValue(new Error('404'));
    const result = createManagedSprite(client, 'disposable');

    expect(reconcile).not.toHaveBeenCalled();
    pending.reject(new Error('provider failed'));

    await expect(result).rejects.toMatchObject({
      machine: 'disposable',
      outcome: 'unknown',
    });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith('disposable');
  });
});
