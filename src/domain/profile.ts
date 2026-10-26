import { isRecord } from '#kernel/guards';

import { OPTION_BOUNDS, optionViolations } from './profile/options';
import { providerViolations } from './profile/provider';
import {
  agentViolations,
  harnessSetViolations,
  isDriverId,
  releaseViolations,
  unknownDriverViolations,
} from './profile/selection';

import type { ProductDeclarations } from '#domain/declarations';
import type { AgentId, HarnessId, NetworkId, ProviderId } from '#domain/ids';
import type { RecordedProfile } from '#domain/recorded';

export {
  MAX_UPDATE_DUE_DAYS,
  OPTION_BOUNDS,
  optionViolations,
} from './profile/options';
export { machineViolations, providerViolations } from './profile/provider';
export {
  agentViolations,
  harnessSetViolations,
  isDriverId,
  releaseViolations,
  unknownDriverViolations,
} from './profile/selection';
export type { OptionViolationsParams } from './profile/options';
export type {
  MachineViolationsParams,
  ProviderViolationsParams,
} from './profile/provider';
export type {
  AgentViolationsParams,
  DriverIdContext,
  ReleaseViolationsParams,
} from './profile/selection';

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

/** default driver choices, keyed by the input that selects among them */
export interface DefaultSelection {
  /** default provider */
  provider: ProviderId;
  /** default ACP agent */
  agent: AgentId;
  /** default harnesses */
  harnesses: readonly HarnessId[];
  /** network when neither a choice nor a network's own inputs select one */
  network: NetworkId;
}

/** drivers and options chosen when nothing else chooses them */
export interface ProfileDefaults {
  /** default driver choices */
  selection: DefaultSelection;
  /** default options */
  options: Readonly<ProfileOptions>;
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

/** decoded value and catalog used for untrusted profile validation */
export interface ParseProfileParams {
  declarations: ProductDeclarations;
  value: unknown;
  options?: ProfileValidationOptions;
}

/** candidate selection and catalog used for profile validation */
export interface ValidateProfileParams {
  declarations: ProductDeclarations;
  candidate: ProfileCandidate;
  options?: ProfileValidationOptions;
}

/** a profile field a violation can be attributed to */
export type ProfileField =
  'provider' | 'agent' | 'harnesses' | 'network' | keyof ProfileOptions;

/** class of one profile violation */
type ProfileViolationCode =
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
interface ValidProfile {
  /** discriminator */
  isValid: true;
  /** the validated profile */
  profile: WorkstationProfile;
}

/** a profile rejected with every violation found */
interface InvalidProfile {
  /** discriminator */
  isValid: false;
  /** every violation found across drivers */
  violations: ProfileViolation[];
}

/** outcome of profile validation */
type ProfileValidation = ValidProfile | InvalidProfile;

/**
 * builds the default profile
 * @param defaults the drivers and options chosen when nothing else chooses them
 * @param network network chosen by the caller's inputs; the default network otherwise
 * @returns today's default workstation profile
 */
export function defaultProfile(
  defaults: ProfileDefaults,
  network: NetworkId = defaults.selection.network,
): WorkstationProfile {
  return {
    provider: defaults.selection.provider,
    agent: defaults.selection.agent,
    harnesses: [...defaults.selection.harnesses],
    network,
    options: { ...defaults.options },
  };
}

/**
 * checks driver ids a provider read back against the registry
 * @param declarations the data every registered driver declares
 * @param recorded ids read from the provider's native record
 * @returns the summary when every singular id and at least one harness are registered
 */
export function registeredSummary(
  declarations: ProductDeclarations,
  recorded: RecordedProfile | undefined,
): ProfileSummary | undefined {
  if (!recorded) {
    return undefined;
  }
  const { provider, agent, network } = recorded;
  const harnesses = recorded.harnesses.filter((id) =>
    isDriverId(id, { declarations, kind: 'harnesses' }),
  );

  return isDriverId(provider, { declarations, kind: 'providers' }) &&
    isDriverId(agent, { declarations, kind: 'agents' }) &&
    isDriverId(network, { declarations, kind: 'networks' }) &&
    harnesses.length > 0
    ? { provider, agent, harnesses, network }
    : undefined;
}

/**
 * validates an untrusted decoded value, such as the profile environment.json stores
 * @param params declarations, decoded value and validation requests
 * @param params.declarations the data every registered driver declares
 * @param params.value value to process
 * @param params.options requests validated alongside the profile
 * @returns the validated profile, or every violation found
 */
export function parseProfile({
  declarations,
  value,
  options,
}: ParseProfileParams): ProfileValidation {
  return isProfileCandidate(value)
    ? validateProfile({ declarations, candidate: value, options })
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
 * @param params resolved candidate, catalog and validation requests
 * @param params.declarations the data every registered driver declares
 * @param params.candidate profile candidate to validate
 * @param params.options requests validated alongside the profile
 * @returns the validated profile, or every violation found
 */
export function validateProfile({
  declarations,
  candidate,
  options = {},
}: ValidateProfileParams): ProfileValidation {
  const { provider, agent, network } = candidate;
  const harnesses = candidate.harnesses.filter((id) =>
    isDriverId(id, { declarations, kind: 'harnesses' }),
  );
  const violations = [
    ...unknownDriverViolations(declarations, candidate),
    ...harnessSetViolations(candidate.harnesses),
    ...(isDriverId(agent, { declarations, kind: 'agents' })
      ? [
          ...agentViolations({
            declarations,
            selected: { agent, harnesses },
            options,
          }),
          ...releaseViolations({
            declarations,
            agent,
            release: candidate.options.agentRelease,
          }),
        ]
      : []),
    ...(isDriverId(provider, { declarations, kind: 'providers' })
      ? providerViolations({
          declarations,
          selected: { provider, options: candidate.options },
          options,
        })
      : []),
    ...optionViolations({
      declarations,
      options: candidate.options,
      selected: { network, harnesses },
    }),
  ];
  // incompatibilities are declared against a fully known selection, so they
  // are checked whenever every id resolves, alongside any other violation
  const profile: WorkstationProfile | undefined =
    isDriverId(provider, { declarations, kind: 'providers' }) &&
    isDriverId(agent, { declarations, kind: 'agents' }) &&
    isDriverId(network, { declarations, kind: 'networks' }) &&
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
    ...(profile ? incompatibilityViolations(declarations, profile) : []),
  ];

  return profile && allViolations.length === 0
    ? { isValid: true, profile }
    : { isValid: false, violations: allViolations };
}

/**
 * reports the incompatibilities the selected provider declares against a fully known selection
 * @param declarations the data every registered driver declares
 * @param profile fully known selection
 * @returns one violation per declared incompatibility that applies
 */
function incompatibilityViolations(
  declarations: ProductDeclarations,
  profile: WorkstationProfile,
): ProfileViolation[] {
  return declarations.providers[profile.provider].incompatibilities
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
    }));
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
