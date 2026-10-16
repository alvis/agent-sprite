import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROFILE_OPTIONS,
  defaultProfile,
  parseProfile,
  validateProfile,
} from '#core/profile';
import { MAX_UPDATE_DUE_DAYS } from '#core/profile-rules';

import type { ProfileCandidate } from '#core/profile';
import type {
  AgentDeclaration,
  HarnessDeclaration,
  ProviderDeclaration,
} from '#drivers/contracts';
import type { NetworkDeclaration } from '#drivers/networks/contracts';

// fixture catalog adding an acp-adapter agent and a harness with an adapter
vi.mock('#core/catalog', () => {
  const sprite: ProviderDeclaration = {
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
  const claude: HarnessDeclaration = {
    id: 'claude',
    kind: 'harnesses',
    displayName: 'Claude Code',
    supportsProxy: true,
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
  const codex: HarnessDeclaration = {
    id: 'codex',
    kind: 'harnesses',
    displayName: 'Codex',
    supportsProxy: false,
  };
  const t3: AgentDeclaration = {
    id: 't3',
    kind: 'agents',
    displayName: 'T3 Code',
    supportedHarnesses: ['claude', 'codex'],
    harnessLaunchMode: 'native-cli',
    supportsPairing: true,
  };
  const relay: AgentDeclaration = {
    id: 'relay',
    kind: 'agents',
    displayName: 'Relay',
    supportedHarnesses: ['claude', 'codex'],
    harnessLaunchMode: 'acp-adapter',
    supportsPairing: false,
  };
  const none: NetworkDeclaration = {
    id: 'none',
    kind: 'networks',
    displayName: 'None',
    supportsExitNode: false,
  };
  const tailscale: NetworkDeclaration = {
    id: 'tailscale',
    kind: 'networks',
    displayName: 'Tailscale',
    supportsExitNode: true,
  };

  return {
    catalog: {
      providers: { sprite },
      harnesses: { claude, codex },
      agents: { t3, relay },
      networks: { none, tailscale },
    },
    DEFAULT_SELECTION: {
      provider: 'sprite',
      agent: 't3',
      harnesses: ['claude', 'codex'],
      network: 'none',
    },
  };
});

const valid: ProfileCandidate = {
  provider: 'sprite',
  agent: 't3',
  harnesses: ['claude', 'codex'],
  network: 'tailscale',
  options: { ...DEFAULT_PROFILE_OPTIONS },
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
  const result = validateProfile(
    { ...valid, ...candidate },
    { isPairingRequested },
  );

  return result.isValid ? [] : result.violations.map(({ code }) => code);
}

describe('fn:defaultProfile', () => {
  it('should reproduce the default workstation with the network chosen by Tailscale inputs', () => {
    expect(defaultProfile('tailscale')).toEqual({
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
    expect(defaultProfile('none').network).toBe('none');
  });
});

describe('fn:validateProfile', () => {
  it('should accept the default profile and an idle timeout of 0', () => {
    expect(violationCodes({})).toEqual([]);
    expect(
      violationCodes({ options: { ...valid.options, idleTimeoutMinutes: 0 } }),
    ).toEqual([]);
  });

  it.each([
    ['zero harnesses', { harnesses: [] }, ['no-harness']],
    ['an unknown harness', { harnesses: ['aider'] }, ['unknown-driver']],
    ['an unknown provider', { provider: 'ec2' }, ['unknown-driver']],
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
      'proxy routing without a proxy-capable harness',
      {
        harnesses: ['codex'],
        options: { ...valid.options, isProxyEnabled: true },
      },
      ['undeclared-capability'],
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
        validateProfile({ ...valid, options: options(above) }),
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
  it('should reject a stored value without the profile structure', () => {
    expect(parseProfile({ provider: 'sprite' })).toEqual({
      isValid: false,
      violations: [expect.objectContaining({ code: 'malformed' })],
    });
  });
});
