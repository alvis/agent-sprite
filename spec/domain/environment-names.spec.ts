import { describe, expect, it } from 'vitest';

import { registry } from '#composition/registry';
import { driverCredentialNames } from '#domain/environment-names';
import { networkIds } from '#domain/networks';

import type { NetworkInputs, ProductDeclarations } from '#domain/declarations';
import type { ServiceDefinition } from '#domain/services';

const inputs: NetworkInputs = {
  account: {
    environment: 'PARTIAL_ACCOUNT',
    prompt: 'Account',
    flag: '--network-account ACCOUNT',
  },
  management: {
    environment: 'PARTIAL_MANAGEMENT_KEY',
    prompt: 'Management key',
    flag: '--network-key-source SOURCE',
    store: 'partial',
  },
  enrollment: {
    environment: 'PARTIAL_ENROLLMENT_KEY',
    flag: '--network-auth-key-source SOURCE',
  },
  exitNode: {
    environment: 'PARTIAL_EXIT_NODE',
    prompt: 'Exit node',
    flag: '--exit-node NODE',
  },
};

const daemon: ServiceDefinition = {
  name: 'partiald',
  command: '/usr/bin/partiald',
  arguments: [],
  account: 'root',
  needs: [],
};

/**
 * declares the registered drivers with the network none replaced by one that declares only the given facts
 * @param facts the optional facts the replacement declares
 * @returns declarations for the credential lookup
 */
function declarationsWith(
  facts: Partial<
    Pick<ProductDeclarations['networks']['none'], 'daemon' | 'inputs'>
  >,
): ProductDeclarations {
  return {
    ...registry,
    networks: {
      none: { ...registry.networks.none, ...facts },
      tailscale: registry.networks.tailscale,
    },
  };
}

describe('fn:driverCredentialNames', () => {
  it('should reserve the credentials of a network that declares inputs without a daemon', () => {
    expect(driverCredentialNames(declarationsWith({ inputs }))).toEqual(
      expect.arrayContaining([
        'PARTIAL_MANAGEMENT_KEY',
        'PARTIAL_ENROLLMENT_KEY',
      ]),
    );
  });

  it.each([{ daemon }])(
    'should reserve no credential for a network that declares no inputs (%j)',
    (facts) => {
      expect(driverCredentialNames(declarationsWith(facts))).not.toContain(
        'PARTIAL_MANAGEMENT_KEY',
      );
    },
  );
});

describe('fn:networkIds', () => {
  it('should list every registered network, including one that declares nothing', () => {
    expect(networkIds()).toEqual(['none', 'tailscale']);
  });
});
