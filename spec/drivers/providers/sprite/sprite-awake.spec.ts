import { mkdtempDisposable } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IncomingHttpHeaders, Server } from 'node:http';

/** one request the fake Sprite API received */
interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** what the fake Sprite API answers */
interface Reply {
  status: number;
  body: string;
  /** true to never answer */
  isSilent?: boolean;
  /** true to answer one byte at a time, so an idle timer never fires */
  isTrickling?: boolean;
}

const { socket } = vi.hoisted(() => ({ socket: { path: '' } }));

// the adapter names the Sprite's own socket; the test redirects only the path
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();

  return {
    ...original,
    request: (
      options: import('node:http').RequestOptions,
      callback: (response: import('node:http').IncomingMessage) => void,
    ) => {
      expect(options.socketPath).toBe('/.sprite/api.sock');

      return original.request(
        { ...options, socketPath: socket.path },
        callback,
      );
    },
  };
});

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const TASK_PATH = '/v1/tasks/open-agent-awake';
const received: Received[] = [];
let reply: Reply = { status: 200, body: '{}' };
let server: Server;
let directory: AsyncDisposable & { path: string };

beforeEach(async () => {
  received.length = 0;
  reply = { status: 200, body: '{}' };
  directory = await mkdtempDisposable(join(tmpdir(), 'open-agent-sprite-'));
  socket.path = join(directory.path, 'api.sock');
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (reply.isSilent) {
        return;
      }
      if (reply.isTrickling) {
        // a declared long body that arrives a byte at a time
        response.writeHead(reply.status, { 'content-length': 1_000 });
        const timer = setInterval(() => {
          response.write('x');
        }, 100);
        response.on('close', () => {
          clearInterval(timer);
        });

        return;
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(socket.path, resolve);
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await directory[Symbol.asyncDispose]();
});

/**
 * hands the adapter a deadline
 * @param offsetMs milliseconds after the pinned current time
 * @returns the adapter's settled outcome
 */
async function applyAfter(offsetMs: number): Promise<void> {
  const { applyAwakeDeadline } =
    await import('#drivers/providers/sprite/guest/sprite-awake');

  return applyAwakeDeadline(new Date(NOW + offsetMs));
}

describe('fn:applyAwakeDeadline', () => {
  it('should create or refresh the one fixed task whose expiry is the whole seconds left', async () => {
    reply = { status: 200, body: '{"name":"open-agent-awake"}' };

    await applyAfter(90_000);

    expect(received).toEqual([
      {
        method: 'PUT',
        url: TASK_PATH,
        headers: expect.objectContaining({
          'host': 'sprite',
          'content-type': 'application/json',
        }),
        body: '{"expire":90}',
      },
    ]);
  });

  it.each([
    [1, 1],
    [999, 1],
    [1_000, 1],
    [1_001, 2],
    [299_999, 300],
    [300_000, 300],
    [300_001, 301],
  ])(
    'should round a deadline %i ms away up to %i seconds and never down',
    async (offsetMs, seconds) => {
      await applyAfter(offsetMs);

      expect(received.map(({ body }) => body)).toEqual([
        JSON.stringify({ expire: seconds }),
      ]);
    },
  );

  it('should send no credential', async () => {
    await applyAfter(60_000);

    expect(Object.keys(received[0]!.headers).sort()).toEqual([
      'connection',
      'content-length',
      'content-type',
      'host',
    ]);
  });

  it.each([
    ['at the current time', 0],
    ['already passed', -5_000],
  ])('should delete the task when the deadline is %s', async (_, offsetMs) => {
    reply = { status: 204, body: '' };

    await applyAfter(offsetMs);

    expect(received).toEqual([
      expect.objectContaining({ method: 'DELETE', url: TASK_PATH, body: '' }),
    ]);
  });

  it('should count a task that is already gone as deleted', async () => {
    reply = {
      status: 404,
      body: '{"error":"task \\"open-agent-awake\\" not found"}',
    };

    await expect(applyAfter(-1)).resolves.toBeUndefined();
  });

  it('should reject when the delete is refused', async () => {
    reply = { status: 500, body: 'boom' };

    await expect(applyAfter(-1)).rejects.toThrow(
      'Sprite task delete answered 500: boom',
    );
  });

  it('should reject with the status and the start of the body when the refresh is refused', async () => {
    reply = { status: 400, body: `{"error":"${'x'.repeat(600)}"}` };

    const failure: unknown = await applyAfter(60_000).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^Sprite task refresh answered 400: \{"error":"x+$/u,
    );
    expect((failure as Error).message.length).toBeLessThan(300);
  });

  it('should apply the longest task the Sprite allows and report a deadline beyond it', async () => {
    await expect(applyAfter(2 * 3_600_000)).rejects.toThrow(
      'the Sprite keeps a task at most 3600 seconds; the deadline is 7200 seconds away',
    );

    expect(received.map(({ body }) => body)).toEqual(['{"expire":3600}']);
  });

  it('should accept a deadline of exactly the longest task', async () => {
    await expect(applyAfter(3_600_000)).resolves.toBeUndefined();

    expect(received.map(({ body }) => body)).toEqual(['{"expire":3600}']);
  });

  it('should reject when the API does not answer within the bound the governor allows', async () => {
    reply = { status: 200, body: '', isSilent: true };
    vi.useRealTimers();
    const { applyAwakeDeadline } =
      await import('#drivers/providers/sprite/guest/sprite-awake');
    const startedAt = Date.now();

    await expect(
      applyAwakeDeadline(new Date(startedAt + 60_000)),
    ).rejects.toThrow('did not answer in time');

    expect(Date.now() - startedAt).toBeLessThan(1_400);
  });

  it('should end a request whose answer trickles in, after the one total timeout, and settle only once the connection has closed', async () => {
    reply = { status: 200, body: '', isTrickling: true };
    vi.useRealTimers();
    const { applyAwakeDeadline } =
      await import('#drivers/providers/sprite/guest/sprite-awake');
    const startedAt = Date.now();

    await expect(
      applyAwakeDeadline(new Date(startedAt + 60_000)),
    ).rejects.toThrow('did not answer in time');

    expect(Date.now() - startedAt).toBeLessThan(1_400);
    const lingering = await new Promise<number>((resolve) => {
      server.getConnections((_, count) => {
        resolve(count);
      });
    });
    expect(lingering).toBe(0);
  });

  it('should reject when no socket answers', async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    await expect(applyAfter(60_000)).rejects.toThrow();
  });
});
