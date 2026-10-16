import { describe, expect, it } from 'vitest';

import { driverCredentialNames } from '#core/environment';
import {
  networkIds,
  networksWithDaemon,
  networksWithInputs,
} from '#core/networks';
import { none } from '#drivers/networks/none/index';

import type { RegisteredNetwork } from '#core/networks';
import type { ServiceDefinition } from '#drivers/guest-channel';
import type { NetworkInputs } from '#drivers/networks/contracts';
import type { ToolSpec } from '#tools/contracts';

const inputs: NetworkInputs = {
  account: { environment: 'PARTIAL_ACCOUNT', prompt: 'Account' },
  management: {
    environment: 'PARTIAL_MANAGEMENT_KEY',
    prompt: 'Management key',
    store: 'partial',
  },
  enrollment: { environment: 'PARTIAL_ENROLLMENT_KEY' },
  exitNode: { environment: 'PARTIAL_EXIT_NODE', prompt: 'Exit node' },
};

const daemon: ServiceDefinition = {
  name: 'partiald',
  command: '/usr/bin/partiald',
  arguments: [],
  account: 'root',
  needs: [],
};

const tools: readonly ToolSpec[] = [
  {
    name: 'partial',
    required: true,
    executables: ['partial'],
    version: { executable: 'partial', args: ['--version'], account: 'root' },
    sources: [{ kind: 'brew', formula: 'partial' }],
  },
];

/**
 * builds a network that declares only the given optional facts
 * @param id fixture identifier, borrowed from the registered ids for typing
 * @param facts the optional facts the fixture declares
 * @returns a fixture network
 */
function fixture(
  id: string,
  facts: Partial<Pick<RegisteredNetwork, 'daemon' | 'inputs' | 'tools'>>,
): RegisteredNetwork {
  return { ...none, ...facts, displayName: id };
}

const inputsOnly = fixture('inputs-only', { inputs });
const daemonOnly = fixture('daemon-only', { daemon });
const installOnly = fixture('install-only', { tools });
const everything = fixture('everything', { inputs, daemon, tools });
const partials = [inputsOnly, daemonOnly, installOnly, everything, none];

describe('fn:networksWithInputs', () => {
  it('should keep every network that declares inputs, whatever else it declares', () => {
    expect(networksWithInputs(partials)).toEqual([inputsOnly, everything]);
  });

  it('should list the registered networks that declare inputs by default', () => {
    expect(networksWithInputs().map(({ id }) => id)).toEqual(['tailscale']);
  });
});

describe('fn:networksWithDaemon', () => {
  it('should keep every network that declares a daemon, whatever else it declares', () => {
    expect(networksWithDaemon(partials)).toEqual([daemonOnly, everything]);
  });

  it('should list the registered networks that declare a daemon by default', () => {
    expect(networksWithDaemon().map(({ id }) => id)).toEqual(['tailscale']);
  });
});

describe('fn:driverCredentialNames', () => {
  it('should reserve the credentials of a network that declares inputs without a daemon', () => {
    expect(driverCredentialNames([inputsOnly])).toEqual(
      expect.arrayContaining([
        'PARTIAL_MANAGEMENT_KEY',
        'PARTIAL_ENROLLMENT_KEY',
      ]),
    );
  });

  it.each([daemonOnly, installOnly])(
    'should reserve no credential for a network that declares no inputs ($displayName)',
    (network) => {
      expect(driverCredentialNames([network])).not.toContain(
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
