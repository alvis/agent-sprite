import { mkdtempDisposable } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { enterIdleForm } from '#drivers/providers/fly-machine/guest/fly-machine-awake';

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from 'node:http';

/** one request the fake Machines API received */
interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

/** what the fake Machines API answers to a method and path; absent paths answer 404 */
type Replies = Record<string, { status: number; body?: string } | 'hangup'>;

const { socket } = vi.hoisted(() => ({ socket: { path: '' } }));

// the adapter names the machine's own socket; the test redirects only the path
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();

  return {
    ...original,
    request: (
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      expect(options.socketPath).toBe('/.fly/api');

      return original.request(
        { ...options, socketPath: socket.path },
        callback,
      );
    },
  };
});

const MACHINE = '/v1/apps/oa-probe/machines/148e21d9a30d08';

/** gives the process the environment the Fly init gives every guest process */
function stubMachine(): void {
  vi.stubEnv('FLY_APP_NAME', 'oa-probe');
  vi.stubEnv('FLY_MACHINE_ID', '148e21d9a30d08');
}

/**
 * describes a machine the way the Machines API returns it
 * @param config the parts of the configuration that decide whether it suspends
 * @returns the JSON body
 */
function described(config: Record<string, unknown>): string {
  return JSON.stringify({ id: '148e21d9a30d08', config });
}

/**
 * enters the idle form against a fake Machines API
 * @param replies answers by `METHOD path`
 * @returns the outcome, and every request the API received
 */
async function enterAgainst(replies: Replies): Promise<{
  outcome: Awaited<ReturnType<typeof enterIdleForm>>;
  received: Received[];
}> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-fly-'),
  );
  socket.path = join(directory.path, 'api.sock');
  const received: Received[] = [];
  const server = createServer((incoming, response) => {
    received.push({
      method: incoming.method,
      url: incoming.url,
      headers: incoming.headers,
    });
    const reply = replies[`${incoming.method} ${incoming.url}`];
    if (reply === 'hangup') {
      incoming.socket.destroy();

      return;
    }
    response.writeHead(reply?.status ?? 404);
    response.end(reply?.body ?? '');
  });
  await new Promise<void>((resolve) => {
    server.listen(socket.path, resolve);
  });
  try {
    return { outcome: await enterIdleForm(), received };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * lists the requests as `METHOD path`
 * @param received requests the fake API saw
 * @returns one entry per request
 */
function calls(received: readonly Received[]): string[] {
  return received.map(({ method, url }) => `${method} ${url}`);
}

describe('fn:enterIdleForm', () => {
  it('should suspend a machine that may suspend, naming itself and sending no credential', async () => {
    stubMachine();
    const { outcome, received } = await enterAgainst({
      [`GET ${MACHINE}`]: {
        status: 200,
        body: described({ guest: { memory_mb: 1_024 } }),
      },
      [`POST ${MACHINE}/suspend`]: { status: 200 },
    });

    expect({
      outcome,
      calls: calls(received),
      headers: received.map(({ headers }) => Object.keys(headers).sort()),
    }).toEqual({
      outcome: { entered: 'memory-suspend' },
      calls: [`GET ${MACHINE}`, `POST ${MACHINE}/suspend`],
      headers: [
        ['connection', 'host'],
        ['connection', 'content-length', 'host'],
      ],
    });
    expect(received[0]?.headers.host).toBe('flaps');
  });

  it.each([
    ['more than 2 GB of memory', { guest: { memory_mb: 4_096 } }],
    ['swap', { guest: { memory_mb: 1_024 }, swap_size_mb: 512 }],
    ['a schedule', { guest: { memory_mb: 1_024 }, schedule: 'daily' }],
  ])(
    'should stop a machine with %s without asking it to suspend',
    async (_, config) => {
      stubMachine();
      const { outcome, received } = await enterAgainst({
        [`GET ${MACHINE}`]: { status: 200, body: described(config) },
        [`POST ${MACHINE}/stop`]: { status: 200 },
      });

      expect({ outcome, calls: calls(received) }).toEqual({
        outcome: { entered: 'stop' },
        calls: [`GET ${MACHINE}`, `POST ${MACHINE}/stop`],
      });
    },
  );

  it('should stop a machine whose environment names more than 2 GB without reading it, as the socket refuses the read', async () => {
    stubMachine();
    vi.stubEnv('FLY_VM_MEMORY_MB', '4096');
    const { outcome, received } = await enterAgainst({
      [`GET ${MACHINE}`]: { status: 401, body: '{"error":"unauthorized"}' },
      [`POST ${MACHINE}/suspend`]: { status: 200 },
      [`POST ${MACHINE}/stop`]: { status: 200 },
    });

    expect({ outcome, calls: calls(received) }).toEqual({
      outcome: { entered: 'stop' },
      calls: [`POST ${MACHINE}/stop`],
    });
  });

  it('should stop the machine through the same socket when the suspend is refused', async () => {
    stubMachine();
    const { outcome, received } = await enterAgainst({
      [`GET ${MACHINE}`]: { status: 200, body: described({}) },
      [`POST ${MACHINE}/suspend`]: { status: 400, body: 'cannot suspend' },
      [`POST ${MACHINE}/stop`]: { status: 200 },
    });

    expect({ outcome, calls: calls(received) }).toEqual({
      outcome: { entered: 'stop' },
      calls: [
        `GET ${MACHINE}`,
        `POST ${MACHINE}/suspend`,
        `POST ${MACHINE}/stop`,
      ],
    });
  });

  it('should still try to suspend when the machine description cannot be read', async () => {
    stubMachine();
    const { outcome, received } = await enterAgainst({
      [`GET ${MACHINE}`]: { status: 500 },
      [`POST ${MACHINE}/suspend`]: { status: 200 },
    });

    expect({ outcome, calls: calls(received) }).toEqual({
      outcome: { entered: 'memory-suspend' },
      calls: [`GET ${MACHINE}`, `POST ${MACHINE}/suspend`],
    });
  });

  it('should report the machine as still running when the suspend and the stop are both refused', async () => {
    stubMachine();
    const { outcome } = await enterAgainst({
      [`GET ${MACHINE}`]: { status: 200, body: described({}) },
      [`POST ${MACHINE}/suspend`]: { status: 412, body: 'not eligible' },
      [`POST ${MACHINE}/stop`]: { status: 500, body: 'boom' },
    });

    expect(outcome).toEqual({
      failure:
        'the machine is still running: suspend answered 412: not eligible; stop answered 500: boom',
    });
  });

  it('should report an unknown outcome, not a failure, and not stop a machine whose suspend request ended without an answer', async () => {
    stubMachine();
    const { outcome, received } = await enterAgainst({
      [`GET ${MACHINE}`]: { status: 200, body: described({}) },
      [`POST ${MACHINE}/suspend`]: 'hangup',
      [`POST ${MACHINE}/stop`]: { status: 200 },
    });

    expect({
      unknown: 'unknown' in outcome && outcome.unknown.slice(0, 61),
      failed: 'failure' in outcome,
      calls: calls(received),
    }).toEqual({
      unknown: 'the suspend request ended without an answer, so the machine m',
      failed: false,
      calls: [`GET ${MACHINE}`, `POST ${MACHINE}/suspend`],
    });
  });

  it('should fail without a request when the guest environment names no machine', async () => {
    stubMachine();
    vi.stubEnv('FLY_MACHINE_ID', '');

    const { outcome, received } = await enterAgainst({});

    expect({ outcome, received }).toEqual({
      outcome: {
        failure:
          'FLY_APP_NAME and FLY_MACHINE_ID are not set to a Fly app and machine, so the machine cannot name itself',
      },
      received: [],
    });
  });

  it('should reject an app name that could change the request path', async () => {
    stubMachine();
    vi.stubEnv('FLY_APP_NAME', '../apps');

    const { outcome, received } = await enterAgainst({});

    expect({ failed: 'failure' in outcome, received }).toEqual({
      failed: true,
      received: [],
    });
  });
});
