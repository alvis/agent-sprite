import { describe, expect, it } from 'vitest';

import { inspectT3Environment } from '#adapters/drivers/agents/t3/evidence';

import type {
  GuestChannel,
  GuestExecResult,
} from '#application/ports/guest-channel';

describe('fn:inspectT3Environment', () => {
  it.each([
    {
      name: 'an unreachable endpoint',
      exitCode: 7,
      stdout: '',
      expected: { ok: false, reason: 'environment-endpoint-unreachable' },
    },
    {
      name: 'a non-OK response',
      exitCode: 0,
      stdout: '{}\n503',
      expected: { ok: false, reason: 'environment-endpoint-status' },
    },
    ...['not-json'].map((body) => ({
      name: `invalid body ${body}`,
      exitCode: 0,
      stdout: `${body}\n200`,
      expected: { ok: false, reason: 'environment-endpoint-invalid' },
    })),
  ])('should classify $name', async ({ exitCode, stdout, expected }) => {
    const guest = {
      exec: async (): Promise<GuestExecResult> => ({
        exitCode,
        stdout,
        stderr: '',
      }),
    } satisfies Partial<GuestChannel>;

    const result = await inspectT3Environment(
      guest as Partial<GuestChannel> as GuestChannel,
    );

    expect(result).toEqual(expected);
  });

  it('should leave evidence absent after a transport failure', async () => {
    const guest = {
      exec: async (): Promise<GuestExecResult> => {
        throw new Error('transport lost');
      },
    } satisfies Partial<GuestChannel>;

    const result = await inspectT3Environment(
      guest as Partial<GuestChannel> as GuestChannel,
    );

    expect(result).toBeUndefined();
  });
});
