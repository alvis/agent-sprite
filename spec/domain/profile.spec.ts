import { describe, expect, it, vi } from 'vitest';

import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';
import {
  defaultProfile,
  parseProfile,
  registeredSummary,
  validateProfile,
  MAX_UPDATE_DUE_DAYS,
} from '#domain/profile';

import type {
  AgentDeclaration,
  GatewayDeclaration,
  HarnessDeclaration,
  NetworkDeclaration,
  ProviderDeclaration,
} from '#domain/declarations';
import type { ProfileCandidate } from '#domain/profile';

// fixture catalog adding an acp-adapter agent and a harness with an adapter
vi.mock('#composition/registry', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('#composition/registry')>();
  const sprite: ProviderDeclaration<'sprite'> = {
    id: 'sprite',
    kind: 'providers',
    displayName: 'Sprite',
    capabilities: {
      guestChannel: 'provider-exec',
      transportNetworks: [],
      keepAwakeMode: 'native-deadline',
      idleForms: ['provider-managed'],
      wakeMode: 'url-traffic',
      supportsCliWakeSleep: false,
      maxAwakeDeadlineMinutes: 60,
      persistence: 'provider-disk',
      exposure: 'provider-url',
      discovery: 'provider-metadata',
      resizeRestarts: false,
    },
    machines: [{ label: 'fixture', cpus: 8, memoryGb: 16 }],
    incompatibilities: [
      {
        reason:
          'Fixture provider cannot reach a codex-only workstation offline',
        appliesTo: ({ network, harnesses }) =>
          network === 'none' &&
          harnesses.length === 1 &&
          harnesses[0] === 'codex',
      },
    ],
    prerequisites: {
      tools: [],
      credential: {
        label: 'Fixture token',
        environment: 'FIXTURE_TOKEN',
        store: 'fixture',
        scope: 'fixture access',
        obtain: 'the fixture console',
        refused: [],
      },
      documentation: [],
    },
    shellAccounts: [],
    images: [{ id: 'fixture', family: 'debian', arch: ['x86_64'] }],
    serviceBackend: 'provider',
  };
  const claude: HarnessDeclaration<'claude'> = {
    id: 'claude',
    kind: 'harnesses',
    displayName: 'Claude Code',
    supportsProxy: true,
    spawnEnvironment: {},
    reservedEnvironment: [],
    acpAdapter: {
      tool: {
        name: 'claude-acp',
        required: true,
        executables: ['claude-acp'],
        version: {
          executable: 'claude-acp',
          args: ['--version'],
          account: 'agent',
        },
        sources: [{ kind: 'npm', package: 'claude-acp', account: 'agent' }],
      },
      launch: { program: 'claude-acp', arguments: [] },
    },
  };
  const codex: HarnessDeclaration<'codex'> = {
    id: 'codex',
    kind: 'harnesses',
    displayName: 'Codex',
    supportsProxy: false,
    spawnEnvironment: {},
    reservedEnvironment: [],
  };
  const t3: AgentDeclaration<'t3', 'claude' | 'codex'> = {
    id: 't3',
    kind: 'agents',
    displayName: 'T3 Code',
    supportedHarnesses: ['claude', 'codex'],
    harnessLaunchMode: 'native-cli',
    supportsPairing: true,
    service: {
      name: 'fixture',
      command: 'fixture',
      arguments: [],
      account: 'agent',
      needs: [],
    },
  };
  const relay: AgentDeclaration<'relay', 'claude' | 'codex'> = {
    id: 'relay',
    kind: 'agents',
    displayName: 'Relay',
    supportedHarnesses: ['claude', 'codex'],
    harnessLaunchMode: 'acp-adapter',
    supportsPairing: false,
    service: {
      name: 'fixture',
      command: 'fixture',
      arguments: [],
      account: 'agent',
      needs: [],
    },
  };
  const none: NetworkDeclaration<'none'> = {
    id: 'none',
    kind: 'networks',
    displayName: 'None',
    supportsExitNode: false,
  };
  const tailscale: NetworkDeclaration<'tailscale'> = {
    id: 'tailscale',
    kind: 'networks',
    displayName: 'Tailscale',
    supportsExitNode: true,
  };

  const cliproxyapi: GatewayDeclaration<'cliproxyapi'> = {
    id: 'cliproxyapi',
    kind: 'gateways',
    displayName: 'CLIProxyAPI',
    inputs: {
      enabled: { environment: 'CLIPROXYAPI_ENABLED' },
      baseUrl: {
        environment: 'CLIPROXYAPI_BASE_URL',
        prompt: 'CLIProxyAPI base URL',
        flag: '--proxy-url URL',
      },
      apiKey: {
        environment: 'CLIPROXYAPI_API_KEY',
        prompt: 'CLIProxyAPI client key',
        flag: '--proxy-api-key-source',
      },
    },
  };

  const mockedRegistry = {
    ...original.registry,
    gateways: {
      ...original.registry.gateways,
      cliproxyapi: {
        ...original.registry.gateways.cliproxyapi,
        ...cliproxyapi,
      },
    },
    providers: {
      ...original.registry.providers,
      sprite: { ...original.registry.providers.sprite, ...sprite },
    },
    harnesses: {
      ...original.registry.harnesses,
      claude: { ...original.registry.harnesses.claude, ...claude },
      codex: { ...original.registry.harnesses.codex, ...codex },
    },
    agents: {
      ...original.registry.agents,
      t3: { ...original.registry.agents.t3, ...t3 },
      relay,
    },
    networks: {
      ...original.registry.networks,
      none: { ...original.registry.networks.none, ...none },
      tailscale: { ...original.registry.networks.tailscale, ...tailscale },
    },
  };

  return { registry: mockedRegistry } satisfies Partial<
    typeof import('#composition/registry')
  >;
});

const valid: ProfileCandidate = {
  provider: 'sprite',
  agent: 't3',
  harnesses: ['claude', 'codex'],
  network: 'tailscale',
  options: { ...defaults.options },
};

/**
 * lists the violation codes a candidate raises
 * @param candidate profile overrides applied to a valid candidate
 * @param isPairingRequested whether pairing is requested
 * @returns violation codes, empty when the profile is valid
 */
function violationCodes(
  candidate: Partial<ProfileCandidate>,
  isPairingRequested = false,
): string[] {
  const result = validateProfile({
    declarations: registry,
    candidate: { ...valid, ...candidate },
    options: { isPairingRequested },
  });

  return result.isValid ? [] : result.violations.map(({ code }) => code);
}

describe('fn:defaultProfile', () => {
  it('should reproduce the default workstation with the network chosen by Tailscale inputs', () => {
    expect(defaultProfile(defaults, 'tailscale')).toEqual({
      provider: 'sprite',
      agent: 't3',
      harnesses: ['claude', 'codex'],
      network: 'tailscale',
      options: {
        isExitNodeEnabled: false,
        isProxyEnabled: false,
        minCpus: 2,
        minMemoryGb: 2,
        idleTimeoutMinutes: 5,
        holdMaxMinutes: 60,
        updateDueIntervalDays: 1,
      },
    });
    expect(defaultProfile(defaults, 'none').network).toBe('none');
  });
});

describe('fn:registeredSummary', () => {
  it('should retain registered ids and discard unrecognized harnesses from a provider record', () => {
    const summary = registeredSummary(registry, {
      provider: 'sprite',
      agent: 't3',
      harnesses: ['unknown-harness', 'claude'],
      network: 'none',
    });

    expect(summary).toEqual({
      provider: 'sprite',
      agent: 't3',
      harnesses: ['claude'],
      network: 'none',
    });
  });

  it.each([
    {
      reason: 'the provider record is absent',
      recorded: undefined,
    },
    {
      reason: 'the provider is unknown',
      recorded: {
        provider: 'unknown-provider',
        agent: 't3',
        harnesses: ['claude'],
        network: 'none',
      },
    },
    {
      reason: 'the agent is unknown',
      recorded: {
        provider: 'sprite',
        agent: 'unknown-agent',
        harnesses: ['claude'],
        network: 'none',
      },
    },
    {
      reason: 'the network is unknown',
      recorded: {
        provider: 'sprite',
        agent: 't3',
        harnesses: ['claude'],
        network: 'unknown-network',
      },
    },
    {
      reason: 'no known harness remains',
      recorded: {
        provider: 'sprite',
        agent: 't3',
        harnesses: ['unknown-harness'],
        network: 'none',
      },
    },
  ])('should withhold a summary when $reason', ({ recorded }) => {
    expect(registeredSummary(registry, recorded)).toBeUndefined();
  });
});

describe('fn:validateProfile', () => {
  it('should identify the proxy flag and environment when no selected harness supports proxy routing', () => {
    expect(
      validateProfile({
        declarations: registry,
        candidate: {
          ...valid,
          harnesses: ['codex'],
          options: { ...valid.options, isProxyEnabled: true },
        },
      }),
    ).toEqual({
      isValid: false,
      violations: [
        {
          code: 'undeclared-capability',
          fields: ['harnesses', 'isProxyEnabled'],
          message: expect.stringMatching(/--proxy.*CLIPROXYAPI_ENABLED/),
        },
      ],
    });
  });

  it('should accept the default profile and an idle timeout of 0', () => {
    expect(violationCodes({})).toEqual([]);
    expect(
      violationCodes({ options: { ...valid.options, idleTimeoutMinutes: 0 } }),
    ).toEqual([]);
  });

  it('should accept the largest offered machine and explain an unavailable minimum', () => {
    const options = {
      ...valid.options,
      minCpus: 8,
      minMemoryGb: 16,
    };

    expect(violationCodes({ options })).toEqual([]);
    expect(
      validateProfile({
        declarations: registry,
        candidate: { ...valid, options: { ...options, minCpus: 9 } },
      }),
    ).toMatchObject({
      isValid: false,
      violations: [
        {
          code: 'undeclared-capability',
          fields: ['provider', 'minCpus', 'minMemoryGb'],
          message:
            'Sprite offers no machine with 9 CPUs and 16 GB; it offers at most 8 CPUs and 16 GB',
        },
      ],
    });
  });

  it('should accept Fly’s largest offered size and reject higher CPU and memory minimums', () => {
    const largest = validateProfile({
      declarations: registry,
      candidate: {
        ...valid,
        provider: 'fly-machine',
        options: { ...valid.options, minCpus: 16, minMemoryGb: 128 },
      },
    });
    const tooLarge = validateProfile({
      declarations: registry,
      candidate: {
        ...valid,
        provider: 'fly-machine',
        options: { ...valid.options, minCpus: 17, minMemoryGb: 129 },
      },
    });

    expect(largest).toMatchObject({ isValid: true });
    expect(tooLarge).toMatchObject({
      isValid: false,
      violations: [
        {
          code: 'undeclared-capability',
          fields: ['provider', 'minCpus', 'minMemoryGb'],
        },
      ],
    });
  });

  it('should reject a fractional CPU minimum without reporting an unavailable machine', () => {
    const result = validateProfile({
      declarations: registry,
      candidate: {
        ...valid,
        options: { ...valid.options, minCpus: 2.5 },
      },
    });

    expect(result).toMatchObject({
      isValid: false,
      violations: [{ code: 'invalid-option', fields: ['minCpus'] }],
    });
  });

  it.each([
    ['zero harnesses', { harnesses: [] }, ['no-harness']],
    ['an unknown harness', { harnesses: ['aider'] }, ['unknown-driver']],
    ['an unknown provider', { provider: 'ec2' }, ['unknown-driver']],
    ['an unknown agent', { agent: 'unregistered-agent' }, ['unknown-driver']],
    [
      'a repeated harness',
      { harnesses: ['claude', 'claude'] },
      ['duplicate-harness'],
    ],
    [
      'exit node with network none',
      {
        network: 'none',
        options: { ...valid.options, isExitNodeEnabled: true },
      },
      ['undeclared-capability'],
    ],
    [
      'a negative idle timeout',
      { options: { ...valid.options, idleTimeoutMinutes: -1 } },
      ['invalid-option'],
    ],
    [
      'a turn-hold maximum of 0',
      { options: { ...valid.options, holdMaxMinutes: 0 } },
      ['invalid-option'],
    ],
    [
      'a fractional due interval',
      { options: { ...valid.options, updateDueIntervalDays: 1.5 } },
      ['invalid-option'],
    ],
    [
      'a due interval beyond a year',
      {
        options: {
          ...valid.options,
          updateDueIntervalDays: MAX_UPDATE_DUE_DAYS + 1,
        },
      },
      ['invalid-option'],
    ],
    [
      'a due interval of 0 days',
      { options: { ...valid.options, updateDueIntervalDays: 0 } },
      ['invalid-option'],
    ],
    [
      'fractional minutes',
      { options: { ...valid.options, idleTimeoutMinutes: 1.5 } },
      ['invalid-option'],
    ],
    [
      'an acp-adapter agent with a harness lacking an adapter',
      { agent: 'relay' },
      ['missing-acp-adapter'],
    ],
    [
      'a profile the provider declares incompatible',
      { network: 'none', harnesses: ['codex'] },
      ['incompatible'],
    ],
  ])('should reject %s', (_, candidate, expected) => {
    expect(violationCodes(candidate)).toEqual(expected);
  });

  it.each([
    ['idleTimeoutMinutes', 60, 61],
    ['holdMaxMinutes', 60, 61],
  ] as const)(
    'should accept %s at the provider cap of %i and refuse it above, naming the option, the provider and the cap',
    (key, cap, above) => {
      const options = (minutes: number): ProfileCandidate['options'] => ({
        ...valid.options,
        [key]: minutes,
      });

      expect(violationCodes({ options: options(cap) })).toEqual([]);
      expect(
        validateProfile({
          declarations: registry,
          candidate: { ...valid, options: options(above) },
        }),
      ).toMatchObject({
        isValid: false,
        violations: [
          {
            code: 'undeclared-capability',
            fields: ['provider', key],
            message: expect.stringMatching(
              new RegExp(`${above} minutes.*"sprite".*at most ${cap} minutes`),
            ),
          },
        ],
      });
    },
  );

  it('should accept an acp-adapter agent when every harness provides an adapter', () => {
    expect(violationCodes({ agent: 'relay', harnesses: ['claude'] })).toEqual(
      [],
    );
  });

  it('should reject pairing from an agent that does not declare it', () => {
    expect(
      violationCodes({ agent: 'relay', harnesses: ['claude'] }, true),
    ).toEqual(['undeclared-capability']);
    expect(violationCodes({}, true)).toEqual([]);
  });

  it('should aggregate every violation instead of stopping at the first', () => {
    expect(
      violationCodes({
        network: 'none',
        harnesses: [],
        options: {
          ...valid.options,
          isExitNodeEnabled: true,
          idleTimeoutMinutes: -1,
          holdMaxMinutes: 0,
        },
      }),
    ).toEqual([
      'no-harness',
      'undeclared-capability',
      'invalid-option',
      'invalid-option',
    ]);
  });
});

describe('fn:parseProfile', () => {
  it('should accept a complete decoded profile with an optional release channel', () => {
    const value = {
      ...valid,
      options: { ...valid.options, agentRelease: 'stable' },
    };

    expect(parseProfile({ declarations: registry, value })).toEqual({
      isValid: true,
      profile: value,
    });
  });

  it('should reject a stored value without the profile structure', () => {
    expect(
      parseProfile({ declarations: registry, value: { provider: 'sprite' } }),
    ).toEqual({
      isValid: false,
      violations: [expect.objectContaining({ code: 'malformed' })],
    });
  });

  it.each([
    { field: 'provider', value: { ...valid, provider: 7 } },
    { field: 'agent', value: { ...valid, agent: 7 } },
    { field: 'harness list', value: { ...valid, harnesses: 'claude' } },
    { field: 'harness entry', value: { ...valid, harnesses: ['claude', 7] } },
    { field: 'network', value: { ...valid, network: false } },
    {
      field: 'exit-node option',
      value: {
        ...valid,
        options: { ...valid.options, isExitNodeEnabled: 'yes' },
      },
    },
    {
      field: 'proxy option',
      value: { ...valid, options: { ...valid.options, isProxyEnabled: 'yes' } },
    },
    {
      field: 'numeric option',
      value: { ...valid, options: { ...valid.options, minCpus: 'many' } },
    },
    {
      field: 'optional release channel',
      value: { ...valid, options: { ...valid.options, agentRelease: 7 } },
    },
  ])('should reject a stored profile with malformed $field', ({ value }) => {
    expect(parseProfile({ declarations: registry, value })).toMatchObject({
      isValid: false,
      violations: [{ code: 'malformed' }],
    });
  });
});
