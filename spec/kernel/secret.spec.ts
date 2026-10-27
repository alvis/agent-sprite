import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { redactResolved } from '#kernel/redaction';
import { Secret, revealSecret } from '#kernel/secret';

describe('host secrets', () => {
  it('should register a host credential for diagnostics while allowing guest delivery', () => {
    const value = 'kernel-secret-host-value';
    const secret = Secret.fromHost('credential-store', value);

    expect(revealSecret(secret)).toBe(value);
    expect(redactResolved(`Provider rejected ${value}`)).not.toContain(value);
    expect(secret.source).toBe('credential-store');
  });

  it('should reject an empty host credential before delivery', () => {
    expect(() => Secret.fromHost('prompt', '')).toThrowError();
  });

  it('should deliver embedded guest contents without printing them', () => {
    const contents = 'gateway_key=kernel-embedded-value';
    const secret = Secret.embedding(contents);

    expect(revealSecret(secret)).toBe(contents);
    expect(String(secret)).not.toContain(contents);
    expect(secret.source).toBe('embedded');
  });

  it('should redact string, JSON, and inspected representations', () => {
    const value = 'kernel-secret-print-value';
    const secret = Secret.fromHost('github', value);

    expect(String(secret)).toBe('[REDACTED]');
    expect(JSON.stringify({ credential: secret })).toBe(
      '{"credential":"[REDACTED]"}',
    );
    expect(inspect(secret)).toContain('Secret(github) [REDACTED]');
    expect(inspect(secret)).not.toContain(value);
  });

  it('should reject a secret wrapper that was not registered for guest delivery', () => {
    const secret = Secret.fromHost('provider-api', 'kernel-secret-proxy-value');
    const wrapper = new Proxy(secret, {});

    expect(() => revealSecret(wrapper)).toThrowError();
  });
});
