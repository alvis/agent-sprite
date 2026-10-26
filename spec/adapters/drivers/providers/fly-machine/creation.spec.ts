import { describe, expect, it, vi } from 'vitest';

import { FlyApi } from '#adapters/drivers/providers/fly-machine/api';
import { createManagedApp } from '#adapters/drivers/providers/fly-machine/creation';
import { InteractionExit } from '#kernel/navigation';
import { OperationContext, withOperation } from '#kernel/operation';

import { DISABLED_NETWORK_PROFILE } from '../../../../fixtures/profile';

import type { WorkstationProfile } from '#domain/profile';

interface Request {
  method: string;
  path: string;
}

const PROFILE: WorkstationProfile = {
  ...DISABLED_NETWORK_PROFILE,
  provider: 'fly-machine',
};

function reply(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * serves one create attempt through the real Fly HTTP client
 * @param replies queued provider answers
 * @param onRequest optional action at a request boundary
 * @returns requests observed in order
 */
function useReplies(
  replies: readonly Response[],
  onRequest?: (request: Request) => void,
): Request[] {
  const remaining = [...replies];
  const seen: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof globalThis.Request ? input.url : input,
      );
      const request = { method: init?.method ?? 'GET', path: url.pathname };
      seen.push(request);
      onRequest?.(request);

      return remaining.shift() ?? reply({ error: 'unexpected request' }, 400);
    }),
  );

  return seen;
}

async function create(profile: WorkstationProfile = PROFILE): Promise<unknown> {
  return createManagedApp({
    api: new FlyApi('token'),
    name: 'alpha',
    organization: 'team',
    region: 'lhr',
    profile,
    port: 3773,
  });
}

describe('Fly app creation reconciliation', () => {
  it('should report a globally taken app name without deleting or looking up another account’s app', async () => {
    const seen = useReplies([reply({ error: 'name already taken' }, 422)]);

    await expect(create()).rejects.toMatchObject({
      machine: 'alpha',
      outcome: 'absent',
      cause: expect.objectContaining({ code: 'conflict' }),
    });
    expect(seen).toEqual([{ method: 'POST', path: '/v1/apps' }]);
  });

  it('should report an indeterminate create when the failed write left a visible app', async () => {
    const seen = useReplies([
      reply({ error: 'request refused' }, 400),
      reply({
        id: 'app-1',
        name: 'alpha',
        internal_numeric_id: 42,
        organization: { slug: 'team' },
      }),
    ]);

    await expect(create()).rejects.toMatchObject({
      machine: 'alpha',
      outcome: 'unknown',
      cause: expect.objectContaining({ code: 'failed' }),
    });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/apps' },
      { method: 'GET', path: '/v1/apps/alpha' },
    ]);
  });

  it('should report an unknown outcome when reconciliation cannot read the app', async () => {
    const seen = useReplies([
      reply({ error: 'request refused' }, 400),
      reply({ error: 'lookup forbidden' }, 403),
    ]);

    await expect(create()).rejects.toMatchObject({
      machine: 'alpha',
      outcome: 'unknown',
      cause: expect.objectContaining({ code: 'failed' }),
    });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/apps' },
      { method: 'GET', path: '/v1/apps/alpha' },
    ]);
  });

  it('should accept concurrent removal of its app during cleanup and confirm absence', async () => {
    const seen = useReplies([
      reply(undefined, 204),
      reply({ error: 'volume unavailable' }, 400),
      reply({ error: 'already removed' }, 404),
      reply({ error: 'missing' }, 404),
    ]);

    await expect(create()).rejects.toMatchObject({
      machine: 'alpha',
      outcome: 'absent',
      cause: expect.objectContaining({ code: 'failed' }),
    });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/apps' },
      { method: 'POST', path: '/v1/apps/alpha/volumes' },
      { method: 'DELETE', path: '/v1/apps/alpha' },
      { method: 'GET', path: '/v1/apps/alpha' },
    ]);
  });

  it('should reconcile a cancelled app create outside the cancelled operation', async () => {
    const controller = new AbortController();
    const seen = useReplies(
      [reply(undefined, 204), reply({ error: 'missing' }, 404)],
      ({ path }) => {
        if (path === '/v1/apps') {
          controller.abort();
        }
      },
    );
    const operation = new OperationContext({ signal: controller.signal });

    await expect(withOperation(operation, create)).rejects.toMatchObject({
      outcome: 'absent',
      cause: new InteractionExit('cancel'),
    });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/apps' },
      { method: 'GET', path: '/v1/apps/alpha' },
    ]);
  });

  it('should report an unknown outcome when cleanup cannot remove its app', async () => {
    const seen = useReplies([
      reply(undefined, 204),
      reply({ error: 'volume unavailable' }, 400),
      reply({ error: 'delete refused' }, 403),
    ]);

    await expect(create()).rejects.toMatchObject({
      machine: 'alpha',
      outcome: 'unknown',
      cause: expect.objectContaining({ code: 'failed' }),
    });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/apps' },
      { method: 'POST', path: '/v1/apps/alpha/volumes' },
      { method: 'DELETE', path: '/v1/apps/alpha' },
    ]);
  });

  it('should clean up an app after cancellation during volume creation', async () => {
    const controller = new AbortController();
    const seen = useReplies(
      [
        reply(undefined, 204),
        reply({ id: 'volume-1' }),
        reply(undefined, 204),
        reply({ error: 'missing' }, 404),
      ],
      ({ path }) => {
        if (path === '/v1/apps/alpha/volumes') {
          controller.abort();
        }
      },
    );
    const operation = new OperationContext({ signal: controller.signal });

    await expect(withOperation(operation, create)).rejects.toMatchObject({
      outcome: 'absent',
      cause: new InteractionExit('cancel'),
    });
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/apps' },
      { method: 'POST', path: '/v1/apps/alpha/volumes' },
      { method: 'DELETE', path: '/v1/apps/alpha' },
      { method: 'GET', path: '/v1/apps/alpha' },
    ]);
  });
});

describe('Fly machine selection before creation', () => {
  it('should refuse an unsupported machine before sending a provider request', async () => {
    const seen = useReplies([]);
    const profile = {
      ...PROFILE,
      options: { ...PROFILE.options, minCpus: 32, minMemoryGb: 256 },
    } satisfies WorkstationProfile;
    const attempt = create(profile);

    await expect(attempt).rejects.toMatchObject({
      name: 'ProviderFault',
      code: 'failed',
      message: expect.stringMatching(/32 CPUs.*256 GB/),
    });
    expect(seen).toEqual([]);
  });
});
