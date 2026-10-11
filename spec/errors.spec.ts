import { APIError } from '@fly/sprites';
import { describe, expect, it } from 'vitest';

import { commandError, resultExitCode } from '#errors';

describe('D10 failure boundaries', () => {
  it.each([401, 403])(
    'should map SDK HTTP %i credential rejection to AUTH and status one',
    (statusCode) => {
      const failure = new APIError(
        'Supplied provider credential was rejected',
        { statusCode },
      );
      const error = commandError(failure);

      expect(error).toMatchObject({
        code: 'AUTH',
        message: 'Supplied provider credential was rejected',
      });
      expect(resultExitCode({ command: 'show', ok: false, error })).toBe(1);
    },
  );

  it('should normalize a non-Error rejection as an unexpected failure with status one', () => {
    const error = commandError({
      reason: 'provider returned an invalid shape',
    });

    expect(error).toMatchObject({ code: 'UNEXPECTED' });
    expect(resultExitCode({ command: 'show', ok: false, error })).toBe(1);
  });

  it('should use the same status table for usage, input and successful results', () => {
    expect(
      resultExitCode({
        command: null,
        ok: false,
        error: { code: 'USAGE', message: 'Unknown flag' },
      }),
    ).toBe(2);
    expect(
      resultExitCode({
        command: 'show',
        ok: false,
        error: {
          code: 'INPUT',
          message: 'Selected env file could not be read',
        },
      }),
    ).toBe(1);
    expect(
      resultExitCode({ command: 'list', ok: true, data: { machines: [] } }),
    ).toBe(0);
  });
});
