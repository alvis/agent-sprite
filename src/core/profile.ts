import { isRecord } from '#utilities/guards';

import { catalog, DEFAULT_SELECTION } from './catalog.js';
import {
  agentViolations,
  harnessSetViolations,
  isDriverId,
  OPTION_BOUNDS,
  optionViolations,
  providerViolations,
  releaseViolations,
  unknownDriverViolations,
} from './profile-rules.js';

import type { RecordedProfile } from '#drivers/contracts';

import type { AgentId, HarnessId, NetworkId, ProviderId } from './catalog.js';

export { isDriverId } from './profile-rules.js';

/** a workstation's complete driver selection */
export interface WorkstationProfile {
  /** selected provider driver id */
  provider: ProviderId;
  /** selected ACP agent driver id */
  agent: AgentId;
  /** selected harness driver ids, at least one */
  harnesses: HarnessId[];
  /** selected network driver id */
  network: NetworkId;
  /** capability-driven options */
  options: ProfileOptions;
}

/** options whose meaning depends on declared driver capabilities */
export interface ProfileOptions {
  /** route egress through an existing approved exit node */
  isExitNodeEnabled: boolean;
  /** route proxy-capable harnesses through an existing CLIProxyAPI hub */
  isProxyEnabled: boolean;
  /** minutes without heartbeat or hold before sleep; 0 never initiates sleep */
  idleTimeoutMinutes: number;
  /** minutes a turn hold lasts after its last refresh */
  holdMaxMinutes: number;
  /** days after the last successful update before another is due */
  updateDueIntervalDays: number;
  /** fewest CPUs the machine must provide */
  minCpus: number;
  /** least memory, in whole gigabytes, the machine must provide */
  minMemoryGb: number;
  /** release channel the agent follows; absent when the agent declares none */
  agentRelease?: string;
}

/** the driver selection a provider records natively for list and plain show */
export type ProfileSummary = Pick<
  WorkstationProfile,
  'provider' | 'agent' | 'harnesses' | 'network'
>;

/** an unvalidated selection whose driver ids may be unknown */
export interface ProfileCandidate {
  /** requested provider driver id */
  provider: string;
  /** requested ACP agent driver id */
  agent: string;
  /** requested harness driver ids */
  harnesses: readonly string[];
  /** requested network driver id */
  network: string;
  /** requested options */
  options: ProfileOptions;
}

/** requests that are validated with a profile but not stored in it */
export interface ProfileValidationOptions {
  /** a pairing code is requested from the ACP agent */
  isPairingRequested?: boolean;
  /** the caller supplied an idle timeout rather than taking the default */
  isIdleTimeoutRequested?: boolean;
}

/** a profile field a violation can be attributed to */
export type ProfileField =
  'provider' | 'agent' | 'harnesses' | 'network' | keyof ProfileOptions;

/** class of one profile violation */
export type ProfileViolationCode =
  | 'malformed'
  | 'unknown-driver'
  | 'no-harness'
  | 'duplicate-harness'
  | 'unsupported-harness'
  | 'missing-acp-adapter'
  | 'undeclared-capability'
  | 'invalid-option'
  | 'incompatible';

/** one reason a profile is rejected */
export interface ProfileViolation {
  /** violation class */
  code: ProfileViolationCode;
  /** human-readable explanation */
  message: string;
  /** every field whose value takes part in the violation */
  fields: readonly ProfileField[];
}

/** a profile that passed validation */
export interface ValidProfile {
  /** discriminator */
  isValid: true;
  /** the validated profile */
  profile: WorkstationProfile;
}

/** a profile rejected with every violation found */
export interface InvalidProfile {
  /** discriminator */
  isValid: false;
  /** every violation found across drivers */
  violations: ProfileViolation[];
}

/** outcome of profile validation */
export type ProfileValidation = ValidProfile | InvalidProfile;

/** default options reproducing today's workstation */
export const DEFAULT_PROFILE_OPTIONS: Readonly<ProfileOptions> = {
  isExitNodeEnabled: false,
  isProxyEnabled: false,
  idleTimeoutMinutes: 5,
  holdMaxMinutes: 60,
  // an update is due a day after the last successful one
  updateDueIntervalDays: 1,
  // 2 GB is the most a Fly machine can have and still suspend from memory
  minCpus: 2,
  minMemoryGb: 2,
};

/**
 * builds the default profile
 * @param network network chosen by the caller's inputs; the default network otherwise
 * @returns today's default workstation profile
 */
export function defaultProfile(
  network: NetworkId = DEFAULT_SELECTION.network,
): WorkstationProfile {
  return {
    provider: DEFAULT_SELECTION.provider,
    agent: DEFAULT_SELECTION.agent,
    harnesses: [...DEFAULT_SELECTION.harnesses],
    network,
    options: { ...DEFAULT_PROFILE_OPTIONS },
  };
}

/**
 * checks driver ids a provider read back against the registry
 * @param recorded ids read from the provider's native record
 * @returns the summary when every singular id and at least one harness are registered
 */
export function registeredSummary(
  recorded: RecordedProfile | undefined,
): ProfileSummary | undefined {
  if (!recorded) {
    return undefined;
  }
  const { provider, agent, network } = recorded;
  const harnesses = recorded.harnesses.filter((id) =>
    isDriverId('harnesses', id),
  );

  return isDriverId('providers', provider) &&
    isDriverId('agents', agent) &&
    isDriverId('networks', network) &&
    harnesses.length > 0
    ? { provider, agent, harnesses, network }
    : undefined;
}

/**
 * validates an untrusted decoded value, such as the profile environment.json stores
 * @param value decoded value
 * @param options requests validated alongside the profile
 * @returns the validated profile, or every violation found
 */
export function parseProfile(
  value: unknown,
  options?: ProfileValidationOptions,
): ProfileValidation {
  return isProfileCandidate(value)
    ? validateProfile(value, options)
    : {
        isValid: false,
        violations: [
          {
            code: 'malformed',
            message: 'Workstation profile is malformed',
            fields: [],
          },
        ],
      };
}

/**
 * checks a resolved selection against the catalog and every selected driver's
 * declared capabilities, aggregating all violations, before any provider call
 * @param candidate selection resolved from flags, environment, prompts and defaults
 * @param options requests validated alongside the profile
 * @returns the validated profile, or every violation found
 */
export function validateProfile(
  candidate: ProfileCandidate,
  options: ProfileValidationOptions = {},
): ProfileValidation {
  const { provider, agent, network } = candidate;
  const harnesses = candidate.harnesses.filter((id) =>
    isDriverId('harnesses', id),
  );
  const violations = [
    ...unknownDriverViolations(candidate),
    ...harnessSetViolations(candidate.harnesses),
    ...(isDriverId('agents', agent)
      ? [
          ...agentViolations(agent, harnesses, options),
          ...releaseViolations(agent, candidate.options.agentRelease),
        ]
      : []),
    ...(isDriverId('providers', provider)
      ? providerViolations(provider, candidate.options, options)
      : []),
    ...optionViolations(candidate.options, network, harnesses),
  ];
  // incompatibilities are declared against a fully known selection, so they
  // are checked whenever every id resolves, alongside any other violation
  const profile: WorkstationProfile | undefined =
    isDriverId('providers', provider) &&
    isDriverId('agents', agent) &&
    isDriverId('networks', network) &&
    harnesses.length === candidate.harnesses.length
      ? {
          provider,
          agent,
          harnesses,
          network,
          options: { ...candidate.options },
        }
      : undefined;
  const allViolations = [
    ...violations,
    ...(profile
      ? catalog.providers[profile.provider].incompatibilities
          .filter((incompatibility) => incompatibility.appliesTo(profile))
          .map(({ reason }) => ({
            code: 'incompatible' as const,
            message: reason,
            fields: [
              'provider' as const,
              'agent' as const,
              'harnesses' as const,
              'network' as const,
              ...OPTION_BOUNDS.map(({ key }) => key),
              'isExitNodeEnabled' as const,
              'isProxyEnabled' as const,
            ],
          }))
      : []),
  ];

  return profile && allViolations.length === 0
    ? { isValid: true, profile }
    : { isValid: false, violations: allViolations };
}

/**
 * checks an untrusted decoded value has the profile's structure
 * @param value decoded value
 * @returns true when every field has its declared type
 */
function isProfileCandidate(value: unknown): value is ProfileCandidate {
  if (!isRecord(value) || !isRecord(value.options)) {
    return false;
  }
  const { options } = value;

  return (
    typeof value.provider === 'string' &&
    typeof value.agent === 'string' &&
    Array.isArray(value.harnesses) &&
    value.harnesses.every((id: unknown) => typeof id === 'string') &&
    typeof value.network === 'string' &&
    typeof options.isExitNodeEnabled === 'boolean' &&
    typeof options.isProxyEnabled === 'boolean' &&
    OPTION_BOUNDS.every(({ key }) => typeof options[key] === 'number') &&
    (options.agentRelease === undefined ||
      typeof options.agentRelease === 'string')
  );
}
