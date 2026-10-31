import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { withCodexAppServer } from '#adapters/drivers/harnesses/codex/app-server';
import { isRecord } from '#kernel/guards';

import type {
  GuestChannel,
  GuestProcess,
} from '#application/ports/guest-channel';

describe('fn:withCodexAppServer', () => {
  it.each([
    { name: 'a server error', response: { error: { code: -1 } } },
    { name: 'a non-object result', response: { result: null } },
  ])(
    'should reject $name after ignoring unrelated frames',
    async ({ response }) => {
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
      const guest = { spawn: () => process } satisfies Partial<GuestChannel>;
      stdin.on('data', (chunk: Buffer) => {
        const frame: unknown = JSON.parse(chunk.toString());
        if (isRecord(frame) && frame.method === 'initialize') {
          for (const message of [
            null,
            { id: 999, result: {} },
            { id: frame.id, method: 'server/request' },
            { id: frame.id, ...response },
          ]) {
            stdout.write(`${JSON.stringify(message)}\n`);
          }
        }
      });
      stdin.on('finish', () => events.emit('exit', 0));

      await expect(
        withCodexAppServer(
          guest as Partial<GuestChannel> as GuestChannel,
          async () => 'unexpected',
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining('Codex initialize'),
        }),
      );
    },
  );
});
