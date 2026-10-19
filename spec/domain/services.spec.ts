import { describe, expect, it } from 'vitest';

import { registry } from '#composition/registry';
import { agentService, dependOnDaemon, networkDaemon } from '#domain/services';

import type { ServiceDefinition } from '#domain/services';

describe('fn:agentService', () => {
  it('should depend on the daemon of a network that declares one', () => {
    const daemon = registry.networks.tailscale.daemon;

    expect(daemon).toBeDefined();
    expect(
      agentService(registry, { agent: 't3', network: 'tailscale' }).needs,
    ).toEqual([daemon?.name]);
  });

  it('should depend on no network when the selected network declares no daemon', () => {
    const service = agentService(registry, { agent: 't3', network: 'none' });

    expect(service.needs).toEqual([]);
    expect(service.name).toBe(registry.agents.t3.service.name);
  });
});

describe('fn:dependOnDaemon', () => {
  const daemon: ServiceDefinition = {
    name: 'netd',
    command: '/bin/netd',
    arguments: [],
    account: 'root',
    needs: [],
  };
  const service: ServiceDefinition = {
    ...daemon,
    name: 'agentd',
    command: '/bin/agentd',
  };

  it('should keep the needs the service declares and add the daemon after them', () => {
    expect(
      dependOnDaemon({ ...service, needs: ['storage'] }, daemon).needs,
    ).toEqual(['storage', 'netd']);
  });

  it('should list a daemon the service already needs once', () => {
    expect(
      dependOnDaemon({ ...service, needs: ['netd'] }, daemon).needs,
    ).toEqual(['netd']);
  });

  it('should keep the declared needs when the network runs no daemon', () => {
    expect(
      dependOnDaemon({ ...service, needs: ['storage'] }, undefined).needs,
    ).toEqual(['storage']);
  });
});

describe('fn:networkDaemon', () => {
  it('should find a daemon only for a network that declares one', () => {
    expect(networkDaemon(registry, 'none')).toBeUndefined();
    expect(networkDaemon(registry, 'tailscale')?.name).toBe('tailscaled');
  });
});
