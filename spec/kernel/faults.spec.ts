import { describe, expect, it } from 'vitest';

import {
  CommandFault,
  ensureError,
  isCancellation,
  providerErrorCode,
  recoveryOf,
  retainRecoveryFailure,
  safeDiagnostic,
} from '#kernel/faults';
import { InteractionExit } from '#kernel/navigation';

describe('recovery failures', () => {
  it('should retain the original error, cause, and each cleanup failure', () => {
    const originalCause = new Error('original cause');
    const primary = new Error('operation failed', { cause: originalCause });
    const cleanup = new Error('cleanup failed');

    expect(
      retainRecoveryFailure({
        primary,
        step: 'remove resource',
        failure: cleanup,
      }),
    ).toBe(primary);
    expect({ primary, recovery: recoveryOf(primary) }).toEqual({
      primary: expect.objectContaining({
        message: 'operation failed',
        cause: expect.objectContaining({ errors: [originalCause, cleanup] }),
      }),
      recovery: {
        originalCause,
        failures: [cleanup],
        details: ['Recovery remove resource failed: cleanup failed'],
      },
    });
  });

  it('should bound public cleanup details while retaining every failure', () => {
    const primary = new Error('operation failed');
    for (let index = 0; index < 7; index += 1) {
      retainRecoveryFailure({
        primary,
        step: `cleanup ${index}`,
        failure: `failure ${index}`,
      });
    }

    const failures = [
      new Error('failure 0', { cause: 'failure 0' }),
      new Error('failure 1', { cause: 'failure 1' }),
      new Error('failure 2', { cause: 'failure 2' }),
      new Error('failure 3', { cause: 'failure 3' }),
      new Error('failure 4', { cause: 'failure 4' }),
      new Error('failure 5', { cause: 'failure 5' }),
      new Error('failure 6', { cause: 'failure 6' }),
    ];
    expect({ primary, recovery: recoveryOf(primary) }).toEqual({
      primary: expect.objectContaining({
        message: 'operation failed',
        cause: expect.objectContaining({ errors: failures }),
      }),
      recovery: {
        originalCause: undefined,
        failures,
        details: [
          'Recovery cleanup 0 failed: failure 0',
          'Recovery cleanup 1 failed: failure 1',
          'Recovery cleanup 2 failed: failure 2',
          'Recovery cleanup 3 failed: failure 3',
          'Recovery cleanup 4 failed: failure 4',
          'Recovery cleanup 5 failed: failure 5',
        ],
      },
    });
  });

  it('should retain recovery evidence when the original error is frozen', () => {
    const primary = Object.freeze(new Error('operation failed'));
    const cleanup = new Error('cleanup failed');

    expect(() =>
      retainRecoveryFailure({ primary, step: 'cleanup', failure: cleanup }),
    ).not.toThrow();
    expect(recoveryOf(primary)?.failures).toEqual([cleanup]);
  });
});

describe('fault normalization', () => {
  it('should preserve an Error and wrap non-Error rejection values with causes', () => {
    const original = new Error('original');
    const rejected = { reason: 'invalid' };

    expect(ensureError(original)).toBe(original);
    expect(ensureError('failure').message).toBe('failure');
    expect(ensureError(rejected).cause).toBe(rejected);
  });

  it('should retain a command category and privacy setting', () => {
    const cause = new Error('private provider failure');
    const fault = new CommandFault({
      code: 'AUTH',
      message: 'Authentication failed',
      cause,
      causeVisibility: 'private',
      details: ['Try another credential'],
    });

    expect(fault).toMatchObject({
      name: 'CommandFault',
      code: 'AUTH',
      causeVisibility: 'private',
      cause,
      details: ['Try another credential'],
    });
    expect(
      new CommandFault({ code: 'INPUT', message: 'Invalid input' }),
    ).toMatchObject({
      causeVisibility: 'public',
      details: [],
    });
  });

  it('should recognize cancel navigation without treating back or faults as cancellation', () => {
    expect(isCancellation(new InteractionExit('cancel'))).toBe(true);
    expect(isCancellation(new InteractionExit('back'))).toBe(false);
    expect(isCancellation(new Error('cancel'))).toBe(false);
  });

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [409, 'CONFLICT'],
    [500, 'PROVIDER'],
    [undefined, 'PROVIDER'],
  ] as const)('should classify provider status %s as %s', (status, code) => {
    expect(providerErrorCode(status)).toBe(code);
  });
});

describe('safe diagnostics', () => {
  it('should remove control characters and bound untrusted text', () => {
    const diagnostic = safeDiagnostic(`  first\nsecond\t${'x'.repeat(300)}  `);

    expect(diagnostic).not.toMatch(/[\n\t]/u);
    expect(diagnostic).toContain('first second');
    expect(diagnostic).toHaveLength(256);
  });
});
