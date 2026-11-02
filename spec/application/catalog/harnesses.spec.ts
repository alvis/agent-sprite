import { describe, expect, it, vi } from 'vitest';

import {
  configureHarnesses,
  harnessDrivers,
  proxyRoute,
} from '#application/catalog/harnesses';
import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';

import type { GuestChannel } from '#application/ports/guest-channel';

const gateway = registry.gateways.cliproxyapi;
const drivers = harnessDrivers(registry, defaults.selection.harnesses);

describe('fn:configureHarnesses', () => {
  it('should leave native authentication on a harness that does not support the selected proxy', async () => {
    const configure = vi.fn<typeof registry.harnesses.claude.configure>(
      async () => undefined,
    );
    const driver = {
      ...registry.harnesses.claude,
      supportsProxy: false,
      configure,
      hooks: {
        ...registry.harnesses.claude.hooks,
        install: vi.fn<typeof registry.harnesses.claude.hooks.install>(
          async () => undefined,
        ),
      },
    } satisfies typeof registry.harnesses.claude;
    const guest =
      {} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
    const route = {
      endpoints: gateway.endpoints('https://hub'),
      apiKey: 'synthetic-key',
    };

    await configureHarnesses(guest, {
      drivers: [driver],
      hub: { record: async () => undefined },
      awakeHook: { program: '/bin/true' },
      proxy: route,
    });

    expect(configure.mock.calls).toEqual([[guest, { proxy: undefined }]]);
  });
});

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

  it('should leave native authentication in place when no proxy credentials are supplied', () => {
    expect(proxyRoute({ enabled: true, gateway, drivers })).toBeUndefined();
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
