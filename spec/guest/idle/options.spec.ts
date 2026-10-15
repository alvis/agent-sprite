import { describe, expect, it } from 'vitest';

import { storedIdleOptions } from '#guest/idle/options';

describe('fn:storedIdleOptions', () => {
  it('should read both stored options', () => {
    expect(
      storedIdleOptions({
        options: { idleTimeoutMinutes: 0, holdMaxMinutes: 15 },
      }),
    ).toEqual({ idleTimeoutMinutes: 0, holdMaxMinutes: 15, diagnostics: [] });
  });

  it('should default each invalid option alone and say why', () => {
    expect(
      storedIdleOptions({
        options: { idleTimeoutMinutes: 10, holdMaxMinutes: 0 },
      }),
    ).toEqual({
      idleTimeoutMinutes: 10,
      holdMaxMinutes: 60,
      diagnostics: [expect.stringContaining('holdMaxMinutes')],
    });
  });

  it.each([
    ['no profile', undefined],
    ['a profile without options', {}],
    [
      'fractional and negative values',
      { options: { idleTimeoutMinutes: 1.5, holdMaxMinutes: -1 } },
    ],
    [
      'text values',
      { options: { idleTimeoutMinutes: '5', holdMaxMinutes: '60' } },
    ],
  ])('should apply the defaults of 5 and 60 minutes for %s', (_, profile) => {
    expect(storedIdleOptions(profile)).toEqual({
      idleTimeoutMinutes: 5,
      holdMaxMinutes: 60,
      diagnostics: [
        expect.stringContaining('idleTimeoutMinutes'),
        expect.stringContaining('holdMaxMinutes'),
      ],
    });
  });

  it('should cap an option beyond what a date can hold', () => {
    const options = storedIdleOptions({
      options: {
        idleTimeoutMinutes: Number.MAX_SAFE_INTEGER,
        holdMaxMinutes: 60,
      },
    });

    expect(options).toEqual({
      idleTimeoutMinutes: 50_000_000,
      holdMaxMinutes: 60,
      diagnostics: [expect.stringContaining('idleTimeoutMinutes')],
    });
  });
});
