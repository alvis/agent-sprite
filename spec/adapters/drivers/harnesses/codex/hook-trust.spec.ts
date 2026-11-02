import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { trustCodexHooks } from '#adapters/drivers/harnesses/codex/hook-trust';
import { CODEX_HOOKS } from '#adapters/drivers/harnesses/codex/paths';
import { isRecord } from '#kernel/guards';

import type {
  GuestChannel,
  GuestProcess,
} from '#application/ports/guest-channel';

const hook = {
  eventName: 'sessionStart',
  command: 'awake',
  sourcePath: CODEX_HOOKS,
  source: 'user',
  handlerType: 'command',
  key: 'owned',
  currentHash: 'hash',
  enabled: true,
  trustStatus: 'trusted',
};

/**
 * serves discovery, trust update and verification over the native transport
 * @param reply supplies a native result based on the requested method
 * @returns isolated guest channel
 */
function codexGuest(
  reply: (
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown>,
): GuestChannel {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const process = Object.assign(events, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: (): void => {
      events.emit('exit', 0);
    },
  }) satisfies GuestProcess;
  stdin.on('data', (chunk: Buffer) => {
    const frame: unknown = JSON.parse(chunk.toString());
    if (
      isRecord(frame) &&
      typeof frame.id === 'number' &&
      typeof frame.method === 'string' &&
      isRecord(frame.params)
    ) {
      stdout.write(
        `${JSON.stringify({ id: frame.id, result: frame.method === 'initialize' ? {} : reply(frame.method, frame.params) })}\n`,
      );
    }
  });
  stdin.on('finish', () => events.emit('exit', 0));

  return {
    spawn: () => process,
  } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
}

describe('fn:trustCodexHooks', () => {
  it.each(['ok', 'okOverridden'])(
    'should trust only the owned command when the write status is %s',
    async (status) => {
      const writes: Array<Record<string, unknown>> = [];
      const guest = codexGuest((method, params) => {
        if (method === 'config/batchWrite') {
          writes.push(params);

          return { status };
        }

        return {
          data: [
            null,
            {},
            {
              hooks: [
                null,
                ...Object.entries({
                  eventName: 'other',
                  command: 'other',
                  sourcePath: '/other',
                  source: 'project',
                  handlerType: 'prompt',
                }).map(([field, value]) => ({ ...hook, [field]: value })),
                hook,
              ],
            },
          ],
        };
      });

      await trustCodexHooks(guest, { SessionStart: 'awake' });

      expect(writes).toEqual([
        {
          edits: [
            {
              keyPath: 'hooks.state',
              value: { owned: { trusted_hash: 'hash' } },
              mergeStrategy: 'upsert',
            },
          ],
          filePath: null,
          expectedVersion: null,
          reloadUserConfig: true,
        },
      ]);
    },
  );

  it.each([
    { name: 'absent discovery', result: {} },
    {
      name: 'duplicate owned hooks',
      result: { data: [{ hooks: [hook, hook] }] },
    },
    ...[{ key: 3 }, { key: '' }, { currentHash: 3 }, { currentHash: '' }].map(
      (fields) => ({
        name: `invalid identity ${JSON.stringify(fields)}`,
        result: { data: [{ hooks: [{ ...hook, ...fields }] }] },
      }),
    ),
  ])('should reject $name', async ({ result }) => {
    const guest = codexGuest(() => result);

    await expect(
      trustCodexHooks(guest, { SessionStart: 'awake' }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'PROVIDER', cause: expect.any(Error) }),
    );
  });

  it('should reject a refused trust write', async () => {
    const guest = codexGuest((method) =>
      method === 'config/batchWrite'
        ? { status: 'failed' }
        : { data: [{ hooks: [hook] }] },
    );

    await expect(
      trustCodexHooks(guest, { SessionStart: 'awake' }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'PROVIDER',
        cause: expect.objectContaining({
          message: expect.stringContaining('trust update'),
        }),
      }),
    );
  });

  it.each([{ enabled: false }, { trustStatus: 'untrusted' }])(
    'should reject hooks left disabled or untrusted: %j',
    async (fields) => {
      const guest = codexGuest((method) =>
        method === 'config/batchWrite'
          ? { status: 'ok' }
          : { data: [{ hooks: [{ ...hook, ...fields }] }] },
      );

      await expect(
        trustCodexHooks(guest, { SessionStart: 'awake' }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'PROVIDER',
          cause: expect.objectContaining({
            message: expect.stringContaining('untrusted'),
          }),
        }),
      );
    },
  );
});
