import { describe, expect, it } from 'vitest';

import { none } from '#adapters/drivers/networks/none';
import {
  networksWithDaemon,
  networksWithInputs,
} from '#application/catalog/networks';
import { registry } from '#composition/registry';

import type { RegisteredNetwork } from '#application/catalog/networks';
import type { NetworkInputs } from '#domain/declarations';
import type { ServiceDefinition } from '#domain/services';
import type { ToolSpec } from '#domain/tools';

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

/** a catalog holding only the given networks */
const catalog = {
  networks: Object.fromEntries(
    partials.map((network, index) => [String(index), network]),
  ),
};

describe('fn:networksWithInputs', () => {
  it('should keep every network that declares inputs, whatever else it declares', () => {
    expect(networksWithInputs(catalog)).toEqual([inputsOnly, everything]);
  });

  it('should list the registered networks that declare inputs', () => {
    expect(networksWithInputs(registry).map(({ id }) => id)).toEqual([
      'tailscale',
    ]);
  });
});

describe('fn:networksWithDaemon', () => {
  it('should keep every network that declares a daemon, whatever else it declares', () => {
    expect(networksWithDaemon(catalog)).toEqual([daemonOnly, everything]);
  });

  it('should list the registered networks that declare a daemon', () => {
    expect(networksWithDaemon(registry).map(({ id }) => id)).toEqual([
      'tailscale',
    ]);
  });
});
