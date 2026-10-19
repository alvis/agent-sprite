import { describe, expect, it } from 'vitest';

import { harnessDrivers, proxyRoute } from '#application/catalog/harnesses';
import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';

const gateway = registry.gateways.cliproxyapi;
const drivers = harnessDrivers(registry, defaults.selection.harnesses);

describe('fn:harnessDrivers', () => {
  it('should resolve drivers in the requested order', () => {
    expect(
      harnessDrivers(registry, ['codex', 'claude']).map(({ id }) => id),
    ).toEqual(['codex', 'claude']);
  });
});

describe('fn:proxyRoute', () => {
  it('should return no route when the proxy is disabled', () => {
    expect(
      proxyRoute({
        enabled: false,
        gateway,
        url: 'https://hub',
        apiKey: 'k',
        drivers,
      }),
    ).toBeUndefined();
  });

  it('should return the route when both URL and key are given', () => {
    expect(
      proxyRoute({
        enabled: true,
        gateway,
        url: 'https://hub',
        apiKey: 'key',
        drivers,
      }),
    ).toEqual({
      endpoints: {
        root: 'https://hub',
        versioned: 'https://hub/v1',
        models: 'https://hub/v1/models',
      },
      apiKey: 'key',
    });
  });

  it.each([
    ['missing key', 'https://hub', undefined],
    ['missing URL', '', 'key'],
  ])(
    'should reject %s with the first routed harness named',
    (_reason, url, apiKey) => {
      expect(() =>
        proxyRoute({ enabled: true, gateway, url, apiKey, drivers }),
      ).toThrow(
        expect.objectContaining({
          code: 'INPUT',
          message: 'Claude proxy URL and API key must be supplied together',
        }),
      );
      expect(() =>
        proxyRoute({
          enabled: true,
          gateway,
          url,
          apiKey,
          drivers: harnessDrivers(registry, ['codex']),
        }),
      ).toThrow(
        expect.objectContaining({
          message: 'Codex proxy URL and API key must be supplied together',
        }),
      );
    },
  );
});
