import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  HOOK_INPUT_LIMIT_BYTES,
  HOOK_INPUT_WAIT_MS,
  hookInputWaitMs,
  parseHookSession,
  readHookSession,
} from '#guest/idle/hook-input';

describe('fn:parseHookSession', () => {
  it('should take the session_id of a hook event and ignore its other fields', () => {
    expect(
      parseHookSession(
        JSON.stringify({
          session_id: 'abc-123',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'hello',
        }),
      ),
    ).toEqual({ session: 'abc-123' });
  });

  it.each([
    ['text that is not JSON', 'session_id=abc'],
    ['a JSON array', '["abc"]'],
    ['JSON null', 'null'],
    ['an event without session_id', '{"hook_event_name":"Stop"}'],
    ['a numeric session_id', '{"session_id":12}'],
    ['an empty session_id', '{"session_id":""}'],
    ['a session_id with a separator', '{"session_id":"a/b"}'],
    [
      'an oversized session_id',
      JSON.stringify({ session_id: 's'.repeat(129) }),
    ],
  ])('should refuse %s', (_, text) => {
    expect(parseHookSession(text)).toEqual({ refused: expect.any(String) });
  });
});

describe('fn:readHookSession', () => {
  it('should join the chunks of one document', async () => {
    const input = Readable.from(['{"session_', 'id":"split"}']);

    expect(await readHookSession(input)).toEqual({ session: 'split' });
  });

  it('should accept a document of exactly the limit', async () => {
    const padding = ' '.repeat(
      HOOK_INPUT_LIMIT_BYTES - '{"session_id":"edge"}'.length,
    );
    const input = Readable.from([
      Buffer.from(`{"session_id":"edge"}${padding}`),
    ]);

    expect(await readHookSession(input)).toEqual({ session: 'edge' });
  });

  it('should refuse a document of more than the limit', async () => {
    const input = Readable.from([
      Buffer.alloc(HOOK_INPUT_LIMIT_BYTES),
      Buffer.from(' '),
    ]);

    expect(await readHookSession(input)).toEqual({
      refused: expect.stringContaining('larger than'),
    });
  });

  it('should refuse input that cannot be read', async () => {
    const input = new Readable({
      read() {
        this.destroy(new Error('closed'));
      },
    });

    expect(await readHookSession(input)).toEqual({
      refused: 'hook input could not be read',
    });
  });

  it('should return at once with a complete document while the input stays open', async () => {
    const input = new PassThrough();
    input.write('{"session_id":"open-stdin"}');
    const started = performance.now();

    expect(await readHookSession(input)).toEqual({ session: 'open-stdin' });
    expect(performance.now() - started).toBeLessThan(HOOK_INPUT_WAIT_MS);
    input.destroy();
  });

  it('should give up within the wait limit when the input stays open and never completes', async () => {
    const input = new PassThrough();
    input.write('{"session_id":');
    const started = performance.now();

    expect(await readHookSession(input, 200)).toEqual({
      refused: 'hook input did not arrive within 200 ms',
    });
    expect(performance.now() - started).toBeLessThan(HOOK_INPUT_WAIT_MS);
    input.destroy();
  });

  it('should keep the wait limit at or below 1.5 seconds', () => {
    expect(HOOK_INPUT_WAIT_MS).toBeLessThanOrEqual(1_500);
  });
});

describe('fn:hookInputWaitMs', () => {
  it('should wait a quarter of a short run budget and no more than the wait limit for a long one', () => {
    expect([hookInputWaitMs(2_000), hookInputWaitMs(8_000)]).toEqual([
      500,
      HOOK_INPUT_WAIT_MS,
    ]);
  });
});
