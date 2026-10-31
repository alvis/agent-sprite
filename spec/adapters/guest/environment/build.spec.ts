import { describe, expect, it } from 'vitest';

import { buildEnvironment } from '#adapters/guest/environment/build';
import { registry } from '#composition/registry';

import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

import type { ServiceDefinition } from '#domain/services';

const service = registry.agents.t3.service;
const params = {
  version: '1.0.0',
  setupAt: '2026-10-31T00:00:00Z',
  state: 'incomplete',
  family: 'debian',
  profile: DISABLED_NETWORK_PROFILE,
  provider: registry.providers.sprite,
  tools: [],
  resolutions: [],
  agent: { id: 't3', service },
  harnesses: [],
  network: null,
  services: [service],
  jobs: [],
} satisfies Parameters<typeof buildEnvironment>[1];

describe('fn:buildEnvironment', () => {
  it('should refuse an agent service that publishes no port', () => {
    const unexposed = {
      name: service.name,
      command: service.command,
      arguments: service.arguments,
      account: service.account,
      needs: service.needs,
    } satisfies ServiceDefinition;

    expect(() =>
      buildEnvironment(registry, {
        ...params,
        agent: { id: 't3', service: unexposed },
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/publishes no port/u),
      }),
    );
  });

  it('should refuse a resolution for an undeclared tool', () => {
    expect(() =>
      buildEnvironment(registry, {
        ...params,
        resolutions: [{ tool: 'undeclared', unavailable: 'not available' }],
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/No tool undeclared/u),
      }),
    );
  });

  it('should refuse an environment whose agent service is missing', () => {
    expect(() =>
      buildEnvironment(registry, { ...params, services: [] }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/inconsistent.*service/u),
      }),
    );
  });

  it('should record no awake adapter for a provider without one', () => {
    const { id, capabilities, serviceBackend } = registry.providers.sprite;
    const provider = {
      id,
      capabilities: { ...capabilities, keepAwakeMode: 'none' },
      serviceBackend,
    } satisfies Parameters<typeof buildEnvironment>[1]['provider'];
    const declarations = {
      ...registry,
      providers: {
        ...registry.providers,
        sprite: { ...registry.providers.sprite, ...provider },
      },
    };

    const environment = buildEnvironment(declarations, {
      ...params,
      provider,
    });

    expect(environment.provider).toEqual(
      expect.objectContaining({ id, awakeAdapter: null }),
    );
  });
});
