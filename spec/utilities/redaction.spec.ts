import { describe, expect, it } from 'vitest';

import { redact, redactResolved, rememberSecret } from '#utilities/redaction';

describe('fn:redact', () => {
  it('should remove repeated literal credentials without interpreting special characters', () => {
    const credential = 'private.$value';

    const sanitized = redact(
      `${credential} failed, retrying ${credential}; preserve public details`,
      [undefined, '', credential],
    );

    expect(sanitized).toBe(
      '[REDACTED] failed, retrying [REDACTED]; preserve public details',
    );
  });

  it('should replace overlapping values in one pass, longest first', () => {
    const short = 'saf08-overlap';
    const long = `${short}-extended`;

    expect(redact(`${long} then ${short} then ${long}`, [short, long])).toBe(
      '[REDACTED] then [REDACTED] then [REDACTED]',
    );
  });
});

describe('fn:redactResolved', () => {
  it('should retain secrets only in memory and omit empty optional credentials', () => {
    rememberSecret(undefined);
    rememberSecret('');
    rememberSecret('session-secret');

    expect(redactResolved('session-secret denied on primary')).toBe(
      '[REDACTED] denied on primary',
    );
  });
});
