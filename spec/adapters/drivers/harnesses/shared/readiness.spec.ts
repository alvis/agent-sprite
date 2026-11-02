import { describe, expect, it } from 'vitest';

import { proxyReadiness } from '#adapters/drivers/harnesses/shared/readiness';

describe('fn:proxyReadiness', () => {
  it('should distinguish configured routing from missing model discovery when a proxy is selected', () => {
    const findings = proxyReadiness(
      'Harness',
      {
        gatewayConfigured: true,
        modelDiscoveryEnabled: false,
        pluginListAvailable: true,
        awakeHooksInstalled: true,
        authentication: 'managed-proxy',
      },
      { proxy: true },
    );

    expect(findings).toEqual([
      { name: 'Harness gateway configuration', status: 'passed' },
      { name: 'Harness model discovery', status: 'failed' },
    ]);
  });
});
