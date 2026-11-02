import { describe, expect, it } from 'vitest';

import { verifyT3Startup } from '#adapters/drivers/agents/t3/startup';

import type {
  GuestChannel,
  GuestExecResult,
} from '#application/ports/guest-channel';

describe('fn:verifyT3Startup', () => {
  it.each(['--no-browser', '--log-level'])(
    'should reject help missing a required flag: %s',
    async (stdout) => {
      const guest = {
        exec: async (): Promise<GuestExecResult> => ({
          stdout,
          stderr: '',
          exitCode: 0,
        }),
      } satisfies Partial<GuestChannel>;

      await expect(
        verifyT3Startup(guest as Partial<GuestChannel> as GuestChannel),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining('startup flags'),
        }),
      );
    },
  );

  it('should accept a CLI supporting both startup flags', async () => {
    const guest = {
      exec: async (): Promise<GuestExecResult> => ({
        stdout: '--log-level --no-browser',
        stderr: '',
        exitCode: 0,
      }),
    } satisfies Partial<GuestChannel>;

    await expect(
      verifyT3Startup(guest as Partial<GuestChannel> as GuestChannel),
    ).resolves.toBeUndefined();
  });
});
