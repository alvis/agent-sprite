import { APIError, ExecError, FilesystemError } from '@fly/sprites';
import { describe, expect, it } from 'vitest';

import { callSprites } from '#adapters/drivers/providers/sprite/failures';

describe('fn:callSprites', () => {
  it.each([
    { statusCode: 404, code: 'not-found' },
    { statusCode: 409, code: 'conflict' },
    { statusCode: 429, code: 'transient' },
    { statusCode: 500, code: 'transient' },
    { statusCode: 400, code: 'failed' },
    { code: 'failed' },
  ])(
    'should classify SDK HTTP failures by status ($statusCode)',
    async ({ code, ...details }) => {
      const failure = new APIError('request rejected', details);

      await expect(
        callSprites(async () => {
          throw failure;
        }),
      ).rejects.toMatchObject({
        name: 'ProviderFault',
        code,
        message: failure.message,
      });
    },
  );

  it.each([
    new ExecError('process failed', {
      exitCode: 1,
      stdout: '',
      stderr: 'denied',
    }),
    new FilesystemError('read failed', 'EACCES', '/private'),
  ])(
    'should translate SDK execution and filesystem errors ($name)',
    async (failure) => {
      await expect(
        callSprites(async () => {
          throw failure;
        }),
      ).rejects.toMatchObject({
        name: 'ProviderFault',
        code: 'failed',
        message: failure.message,
      });
    },
  );
});
