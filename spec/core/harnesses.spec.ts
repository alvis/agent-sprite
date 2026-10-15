import { describe, expect, it } from 'vitest';

import {
  harnessDrivers,
  harnessIds,
  harnessLabel,
  isHarnessId,
  proxyRoute,
} from '#core/harnesses';

const drivers = harnessDrivers();

describe('fn:harnessIds', () => {
  it('should list every registered harness in registration order', () => {
    expect(harnessIds()).toEqual(['claude', 'codex']);
  });
});

describe('fn:isHarnessId', () => {
  it('should accept registered identifiers only', () => {
    expect(isHarnessId('claude')).toBe(true);
    expect(isHarnessId('toString')).toBe(false);
    expect(isHarnessId('gemini')).toBe(false);
  });
});

describe('fn:harnessLabel', () => {
  it('should capitalize the identifier', () => {
    expect(harnessIds().map(harnessLabel)).toEqual(['Claude', 'Codex']);
  });
});

describe('fn:harnessDrivers', () => {
  it('should resolve drivers in the requested order', () => {
    expect(harnessDrivers(['codex', 'claude']).map(({ id }) => id)).toEqual([
      'codex',
      'claude',
    ]);
  });
});

describe('fn:proxyRoute', () => {
  it('should return no route when the proxy is disabled', () => {
    expect(
      proxyRoute({ enabled: false, url: 'https://hub', apiKey: 'k', drivers }),
    ).toBeUndefined();
  });

  it('should return the route when both URL and key are given', () => {
    expect(
      proxyRoute({ enabled: true, url: 'https://hub', apiKey: 'key', drivers }),
    ).toEqual({ url: 'https://hub', apiKey: 'key' });
  });

  it.each([
    ['missing key', 'https://hub', undefined],
    ['missing URL', '', 'key'],
  ])(
    'should reject %s with the first routed harness named',
    (_reason, url, apiKey) => {
      expect(() => proxyRoute({ enabled: true, url, apiKey, drivers })).toThrow(
        expect.objectContaining({
          code: 'INPUT',
          message: 'Claude proxy URL and API key must be supplied together',
        }),
      );
      expect(() =>
        proxyRoute({
          enabled: true,
          url,
          apiKey,
          drivers: harnessDrivers(['codex']),
        }),
      ).toThrow(
        expect.objectContaining({
          message: 'Codex proxy URL and API key must be supplied together',
        }),
      );
    },
  );
});
