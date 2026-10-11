import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#errors';
import { writeGuestFile } from '#integrations/guest/files';
import {
  currentGuestTransaction,
  withGuestTransaction,
} from '#integrations/guest/transaction';
import { OperationContext, withOperation } from '#operation';
import { rememberSecret } from '#utilities/redaction';

import type { SpriteCommand } from '@fly/sprites';

type Request = { type: string; id: number };
type Reply = (event: object) => void;
type StartupFailure = {
  stderrChunks: readonly string[];
  event: { type: 'exit'; code: number } | { type: 'error'; cause: Error };
};

/**
 * Framed SDK transport only; it does not simulate flock or guest ownership.
 * @param onRequest per-request frame response from the mocked SDK boundary
 * @param startup optional SDK transport failure before worker readiness
 * @returns exact Sprite and observed mock calls
 */
function createFrameSprite(
  onRequest: (request: Request, reply: Reply, exit: () => void) => void,
  startup?: StartupFailure,
) {
  const sprite = new Sprite(
    'transaction-frame',
    new SpritesClient('sdk-token'),
  );
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closed = false;
  const reply: Reply = (event) => {
    if (!closed) {
      stdout.write(`${JSON.stringify(event)}\n`);
    }
  };
  const shape = {
    stdin,
    stdout,
    stderr,
    close: vi.fn(() => {
      closed = true;
      stdout.end();
      stderr.end();
    }),
  } satisfies Partial<SpriteCommand>;
  const command = Object.assign(new EventEmitter(), shape);
  const sdkCommand = command as Pick<
    SpriteCommand,
    'stdin' | 'stdout' | 'stderr' | 'close'
  > as SpriteCommand;
  const spawn = vi.spyOn(sprite, 'spawn').mockImplementation(() => {
    if (startup) {
      setImmediate(() => {
        for (const chunk of startup.stderrChunks) {
          stderr.write(chunk);
        }
        if (startup.event.type === 'exit') {
          command.emit('exit', startup.event.code);
        } else {
          command.emit('error', startup.event.cause);
        }
      });
    }

    return sdkCommand;
  });
  const requests: Request[] = [];
  let lines = 0;
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      lines++;
      if (lines === 4) {
        reply({ type: 'ready', installed: false });
      } else if (lines > 4) {
        const request: Request = JSON.parse(line);
        if (request.type !== 'heartbeat') {
          requests.push(request);
          onRequest(request, reply, () => command.emit('exit', 0));
        }
      }
    }
  });
  stdin.on('end', () => {
    if (!startup) {
      reply({ type: 'released' });
    }
  });
  queueMicrotask(() => {
    if (!startup) {
      stdout.write('loc');
      stdout.write('ked\n');
    }
  });

  return { sprite, spawn, requests, stderr };
}

function success(request: Request, reply: Reply): void {
  reply({ type: 'accepted', id: request.id });
  reply({ type: 'settled', id: request.id, result: {} });
}

describe('fn:withGuestTransaction', () => {
  it('should report a pre-ready SDK transport failure while redacting a secret split across stderr chunks', async () => {
    const token = 'liv01-fragmented-private-token';
    const sdkCause = new Error('private-sdk-transport-body');
    rememberSecret(token);
    const { sprite } = createFrameSprite(success, {
      stderrChunks: [
        'cannot open /var/lock/agent-sprite-update.lock: ',
        token.slice(0, 12),
        token.slice(12),
        '\x1b[31m directory absent\n',
      ],
      event: { type: 'error', cause: sdkCause },
    });
    const action = vi.fn(async () => undefined);
    const failure: unknown = await withGuestTransaction(sprite, action).catch(
      (error: unknown) => error,
    );
    const diagnostic = commandError(failure);

    expect(action).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('pending remote work may be unfinished'),
      cause: expect.objectContaining({
        cause: sdkCause,
        causeVisibility: 'private',
      }),
    });
    expect(diagnostic).toMatchObject({
      code: 'PROVIDER',
      details: [
        expect.stringContaining(
          'Guest transaction transport failed: cannot open /var/lock/agent-sprite-update.lock',
        ),
      ],
    });
    expect(diagnostic.details?.join(' ')).toContain('[REDACTED]');
    expect(JSON.stringify(diagnostic)).not.toContain(token);
    expect(JSON.stringify(diagnostic)).not.toContain(sdkCause.message);
    expect(JSON.stringify(diagnostic)).not.toContain('\x1b');
  });

  it('should omit oversized startup stderr while retaining the SDK exit and uncertain-work status', async () => {
    const { sprite } = createFrameSprite(success, {
      stderrChunks: ['oversized-private-body'.repeat(4000)],
      event: { type: 'exit', code: 2 },
    });
    const failure: unknown = await withGuestTransaction(
      sprite,
      async () => undefined,
    ).catch((error: unknown) => error);
    const diagnostic = commandError(failure);

    expect(diagnostic).toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('pending remote work may be unfinished'),
      details: [
        expect.stringContaining('Guest transaction exited with code 2'),
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('oversized-private-body');
  });

  it('should exclude post-ready stderr from an uncertain request failure', async () => {
    const framed = createFrameSprite((request, reply, exit) => {
      reply({ type: 'accepted', id: request.id });
      framed.stderr.write('post-ready-private-request-body');
      exit();
    });
    const failure: unknown = await withGuestTransaction(
      framed.sprite,
      async () =>
        writeGuestFile(framed.sprite, {
          path: '/opt/agent-sprite/post-ready',
          contents: 'private-test-value',
        }),
    ).catch((error: unknown) => error);
    const diagnostic = commandError(failure);

    expect(diagnostic).toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('pending remote work may be unfinished'),
    });
    expect(JSON.stringify(diagnostic)).toContain(
      'Guest transaction exited with code 0',
    );
    expect(JSON.stringify(diagnostic)).not.toContain(
      'post-ready-private-request-body',
    );
  });

  it.each([
    { name: 'non-string failure', settlement: { failure: 123 } },
    { name: 'missing outcome', settlement: {} },
    { name: 'both outcomes', settlement: { failure: 'EIO', result: {} } },
  ])('should reject $name for a protected mutation', async ({ settlement }) => {
    const { sprite, spawn } = createFrameSprite((request, reply) => {
      reply({ type: 'accepted', id: request.id });
      reply({ type: 'settled', id: request.id, ...settlement });
    });

    await expect(
      withGuestTransaction(sprite, async () =>
        writeGuestFile(sprite, {
          path: '/opt/agent-sprite/malformed-settlement',
          contents: 'private-test-value',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'run',
      invoke: async (sprite: Sprite) =>
        currentGuestTransaction(sprite)!.run(['/bin/true'], {}),
      result: { stdout: '', stderr: '', exitCode: 'zero' },
    },
    {
      name: 'read',
      invoke: async (sprite: Sprite) =>
        currentGuestTransaction(sprite)!.read('/opt/data'),
      result: { contents: 3 },
    },
    {
      name: 'exists',
      invoke: async (sprite: Sprite) =>
        currentGuestTransaction(sprite)!.exists('/opt/data'),
      result: { exists: 'yes' },
    },
    {
      name: 'write',
      invoke: async (sprite: Sprite) =>
        currentGuestTransaction(sprite)!.write({
          path: '/opt/data',
          contents: 'x',
        }),
      result: { unexpected: true },
    },
    {
      name: 'chown',
      invoke: async (sprite: Sprite) =>
        currentGuestTransaction(sprite)!.chown('/opt/data', 1000, 1000),
      result: [],
    },
    {
      name: 'remove',
      invoke: async (sprite: Sprite) =>
        currentGuestTransaction(sprite)!.remove('/opt/data'),
      result: null,
    },
  ])(
    'should reject malformed $name result before completion',
    async ({ invoke, result }) => {
      const { sprite } = createFrameSprite((request, reply) => {
        reply({ type: 'accepted', id: request.id });
        reply({ type: 'settled', id: request.id, result });
      });

      await expect(
        withGuestTransaction(sprite, async () => {
          await invoke(sprite);
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER' });
    },
  );

  it('should reject settlement before acceptance', async () => {
    const { sprite } = createFrameSprite((request, reply) => {
      reply({ type: 'settled', id: request.id, result: {} });
    });

    await expect(
      withGuestTransaction(sprite, async () =>
        currentGuestTransaction(sprite)!.write({
          path: '/opt/data',
          contents: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  it('should reuse only the exact Sprite and opens another owner for an independent Sprite', async () => {
    const first = createFrameSprite(success);
    const second = createFrameSprite(success);

    await withGuestTransaction(first.sprite, async () => {
      await withGuestTransaction(first.sprite, async () => {
        await currentGuestTransaction(first.sprite)!.write({
          path: '/opt/first',
          contents: 'x',
        });
      });
      await withGuestTransaction(second.sprite, async () => {
        await currentGuestTransaction(second.sprite)!.write({
          path: '/opt/second',
          contents: 'y',
        });
      });
    });

    expect(first.spawn).toHaveBeenCalledOnce();
    expect(second.spawn).toHaveBeenCalledOnce();
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it('should stop admission after cancellation', async () => {
    const { sprite, requests } = createFrameSprite(success);
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });

    await expect(
      withOperation(context, async () =>
        withGuestTransaction(sprite, async () => {
          controller.abort();

          return currentGuestTransaction(sprite)!.write({
            path: '/opt/late',
            contents: 'x',
          });
        }),
      ),
    ).rejects.toMatchObject({ action: 'cancel' });
    expect(requests).toHaveLength(0);
  });

  it('should not treat an SDK exit before settlement as release', async () => {
    const { sprite } = createFrameSprite((request, reply, exit) => {
      reply({ type: 'accepted', id: request.id });
      exit();
    });

    await expect(
      withGuestTransaction(sprite, async () =>
        currentGuestTransaction(sprite)!.write({
          path: '/opt/data',
          contents: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER' });
  });
});
