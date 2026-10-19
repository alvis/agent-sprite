import { largestMachine, pickMachine } from '#domain/machine-sizes';
import { proxySelectionLabel, selectionLabel } from '#domain/selection-inputs';

import type { ProductDeclarations } from '#domain/declarations';
import type {
  AgentId,
  DriverId,
  DriverKind,
  HarnessId,
  ProviderId,
} from '#domain/ids';

import type {
  ProfileCandidate,
  ProfileField,
  ProfileOptions,
  ProfileValidationOptions,
  ProfileViolation,
} from '#domain/profile';

/** longest update due interval: one year */
export const MAX_UPDATE_DUE_DAYS = 365;

/** a whole-number option's bound */
interface OptionBound {
  /** option key */
  key: keyof ProfileOptions;
  /** how the caller names the option */
  label: string;
  /** smallest valid value */
  minimum: number;
  /** largest valid value, when the option has one */
  maximum?: number;
  /** unit used in the violation message */
  unit: 'minutes' | 'days' | 'CPUs' | 'GB';
}

/** whole-number option bounds checked by validation */
export const OPTION_BOUNDS: readonly OptionBound[] = [
  {
    key: 'idleTimeoutMinutes',
    label: selectionLabel('idleTimeoutMinutes'),
    minimum: 0,
    unit: 'minutes',
  },
  {
    key: 'holdMaxMinutes',
    label: selectionLabel('holdMaxMinutes'),
    minimum: 1,
    unit: 'minutes',
  },
  {
    key: 'updateDueIntervalDays',
    label: selectionLabel('updateDueIntervalDays'),
    minimum: 1,
    maximum: MAX_UPDATE_DUE_DAYS,
    unit: 'days',
  },
  {
    key: 'minCpus',
    label: selectionLabel('minCpus'),
    minimum: 1,
    unit: 'CPUs',
  },
  {
    key: 'minMemoryGb',
    label: selectionLabel('minMemoryGb'),
    minimum: 1,
    unit: 'GB',
  },
];

/**
 * tells whether an id names a registered driver of one kind
 * @param declarations the data every registered driver declares
 * @param kind catalog section to look in
 * @param id identifier requested by a flag, prompt or stored profile
 * @returns true when the catalog registers the id under the kind
 */
export function isDriverId<Kind extends DriverKind>(
  declarations: ProductDeclarations,
  kind: Kind,
  id: string,
): id is DriverId<Kind> & string {
  return Object.hasOwn(declarations[kind], id);
}

/** one driver id a selection requests */
interface RequestedDriver {
  /** catalog section the id belongs to */
  kind: DriverKind;
  /** profile field the id was selected through */
  field: 'provider' | 'agent' | 'harnesses' | 'network';
  /** how the driver kind is named to the caller */
  label: string;
  /** requested id */
  id: string;
}

/**
 * reports every requested id the catalog does not register
 * @param declarations the data every registered driver declares
 * @param candidate requested selection
 * @returns one violation per id the catalog does not register
 */
export function unknownDriverViolations(
  declarations: ProductDeclarations,
  candidate: ProfileCandidate,
): ProfileViolation[] {
  const requested: RequestedDriver[] = [
    {
      kind: 'providers',
      field: 'provider',
      label: 'provider',
      id: candidate.provider,
    },
    {
      kind: 'agents',
      field: 'agent',
      label: 'ACP agent',
      id: candidate.agent,
    },
    ...candidate.harnesses.map((id): RequestedDriver => ({
      kind: 'harnesses',
      field: 'harnesses',
      label: 'harness',
      id,
    })),
    {
      kind: 'networks',
      field: 'network',
      label: 'network',
      id: candidate.network,
    },
  ];

  return requested
    .filter(({ kind, id }) => !isDriverId(declarations, kind, id))
    .map(({ kind, field, label, id }) => ({
      code: 'unknown-driver',
      message: `Unknown ${label} "${id}"; available: ${Object.keys(declarations[kind]).join(', ')}`,
      fields: [field],
    }));
}

/**
 * requires at least one harness, each selected once
 * @param harnesses requested harness ids
 * @returns violations for an empty selection and each repeated id
 */
export function harnessSetViolations(
  harnesses: readonly string[],
): ProfileViolation[] {
  const duplicates = harnesses.filter(
    (id, index) => harnesses.indexOf(id) !== index,
  );

  return [
    ...(harnesses.length === 0
      ? [
          {
            code: 'no-harness' as const,
            message: `At least one harness must be selected with ${selectionLabel('harnesses')}`,
            fields: ['harnesses' as const],
          },
        ]
      : []),
    ...[...new Set(duplicates)].map((id) => ({
      code: 'duplicate-harness' as const,
      message: `Harness "${id}" is selected more than once`,
      fields: ['harnesses' as const],
    })),
  ];
}

/**
 * checks harness support, ACP adapter availability and pairing for the agent
 * @param declarations the data every registered driver declares
 * @param selected the known ACP agent id and known requested harness ids
 * @param selected.agent known ACP agent id
 * @param selected.harnesses known requested harness ids
 * @param options requests validated alongside the profile
 * @returns violations the selected ACP agent's declarations raise
 */
export function agentViolations(
  declarations: ProductDeclarations,
  selected: { agent: AgentId; harnesses: readonly HarnessId[] },
  options: ProfileValidationOptions,
): ProfileViolation[] {
  const { agent, harnesses } = selected;
  const declaration = declarations.agents[agent];

  return [
    ...harnesses
      .filter((id) => !declaration.supportedHarnesses.includes(id))
      .map((id) => ({
        code: 'unsupported-harness' as const,
        message: `ACP agent "${agent}" does not support harness "${id}"`,
        fields: ['agent' as const, 'harnesses' as const],
      })),
    ...(declaration.harnessLaunchMode === 'acp-adapter'
      ? harnesses
          .filter((id) => declarations.harnesses[id].acpAdapter === undefined)
          .map((id) => ({
            code: 'missing-acp-adapter' as const,
            message: `ACP agent "${agent}" launches ACP adapters, but harness "${id}" provides none`,
            fields: ['agent' as const, 'harnesses' as const],
          }))
      : []),
    ...(options.isPairingRequested && !declaration.supportsPairing
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `ACP agent "${agent}" does not support pairing (--with-pair-code)`,
            fields: ['agent' as const],
          },
        ]
      : []),
  ];
}

/**
 * checks the release channel against the channels the ACP agent declares
 * @param declarations the data every registered driver declares
 * @param agent known ACP agent id
 * @param release requested release channel, absent for the agent's default
 * @returns a violation when the agent declares no channels or not this one
 */
export function releaseViolations(
  declarations: ProductDeclarations,
  agent: AgentId,
  release: string | undefined,
): ProfileViolation[] {
  if (release === undefined) {
    return [];
  }
  const { releaseChannels } = declarations.agents[agent];
  if (releaseChannels === undefined) {
    return [
      {
        code: 'undeclared-capability',
        message: `ACP agent "${agent}" declares no release channels (${selectionLabel('agentRelease')})`,
        fields: ['agent', 'agentRelease'],
      },
    ];
  }

  return releaseChannels.channels.some(({ id }) => id === release)
    ? []
    : [
        {
          code: 'invalid-option',
          message: `Unknown release channel "${release}" for ACP agent "${agent}"; available: ${releaseChannels.channels.map(({ id }) => id).join(', ')}`,
          fields: ['agent', 'agentRelease'],
        },
      ];
}

/**
 * checks option bounds and that every enabled option has a declaring driver
 * @param declarations the data every registered driver declares
 * @param options requested options
 * @param selected the requested network and known requested harnesses
 * @param selected.network requested network id, possibly unknown
 * @param selected.harnesses known requested harness ids
 * @returns violations for out-of-bound or capability-less options
 */
export function optionViolations(
  declarations: ProductDeclarations,
  options: ProfileOptions,
  selected: { network: string; harnesses: readonly HarnessId[] },
): ProfileViolation[] {
  const { network, harnesses } = selected;

  return [
    ...(options.isExitNodeEnabled &&
    isDriverId(declarations, 'networks', network) &&
    !declarations.networks[network].supportsExitNode
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `${selectionLabel('isExitNodeEnabled')} needs a network that supports exit nodes; "${network}" does not`,
            fields: ['network' as const, 'isExitNodeEnabled' as const],
          },
        ]
      : []),
    ...(options.isProxyEnabled &&
    !harnesses.some((id) => declarations.harnesses[id].supportsProxy)
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `${proxySelectionLabel(declarations)} needs a selected harness that supports CLIProxyAPI`,
            fields: ['harnesses' as const, 'isProxyEnabled' as const],
          },
        ]
      : []),
    ...OPTION_BOUNDS.filter(
      ({ key, minimum, maximum }) =>
        !Number.isSafeInteger(options[key]) ||
        Number(options[key]) < minimum ||
        Number(options[key]) > (maximum ?? Number.MAX_SAFE_INTEGER),
    ).map(({ key, label, minimum, maximum, unit }) => ({
      code: 'invalid-option' as const,
      message: `${label} must be a whole number of ${unit} ${
        maximum === undefined
          ? `of at least ${String(minimum)}`
          : `from ${String(minimum)} to ${String(maximum)}`
      }`,
      fields: [key],
    })),
  ];
}

/**
 * checks the requests only a provider's declared capabilities allow
 * @param declarations the data every registered driver declares
 * @param selected the known provider id and the requested option values
 * @param selected.provider known provider id
 * @param selected.options the requested option values
 * @param options requests validated alongside the profile
 * @returns violations the selected provider's declarations raise
 */
export function providerViolations(
  declarations: ProductDeclarations,
  selected: { provider: ProviderId; options: ProfileOptions },
  options: ProfileValidationOptions,
): ProfileViolation[] {
  const { provider, options: candidateOptions } = selected;
  const { keepAwakeMode, maxAwakeDeadlineMinutes } =
    declarations.providers[provider].capabilities;
  const awakeOptions = [
    'idleTimeoutMinutes',
    'holdMaxMinutes',
  ] as const satisfies ReadonlyArray<keyof ProfileOptions>;

  return [
    ...(options.isIdleTimeoutRequested && keepAwakeMode === 'none'
      ? [
          {
            code: 'undeclared-capability' as const,
            message: `${selectionLabel('idleTimeoutMinutes')} needs a provider that keeps workstations awake; "${provider}" does not`,
            fields: ['provider', 'idleTimeoutMinutes'] as ProfileField[],
          },
        ]
      : []),
    ...machineViolations(declarations, provider, candidateOptions),
    ...(maxAwakeDeadlineMinutes === null
      ? []
      : awakeOptions
          .filter((key) => candidateOptions[key] > maxAwakeDeadlineMinutes)
          .map((key) => ({
            code: 'undeclared-capability' as const,
            message: `${selectionLabel(key)} of ${String(candidateOptions[key])} minutes is more than provider "${provider}" can keep a workstation awake: at most ${String(maxAwakeDeadlineMinutes)} minutes`,
            fields: ['provider', key] as ProfileField[],
          }))),
  ];
}

/**
 * checks the minimum machine size against the machines the provider offers
 * @param declarations the data every registered driver declares
 * @param provider known provider id
 * @param options requested options
 * @returns a violation naming the provider's largest machine when none meets the minimums
 */
export function machineViolations(
  declarations: ProductDeclarations,
  provider: ProviderId,
  options: ProfileOptions,
): ProfileViolation[] {
  const { displayName, machines } = declarations.providers[provider];
  const { minCpus, minMemoryGb } = options;
  if (
    !Number.isSafeInteger(minCpus) ||
    !Number.isSafeInteger(minMemoryGb) ||
    pickMachine(machines, { cpus: minCpus, memoryGb: minMemoryGb })
  ) {
    return [];
  }
  const largest = largestMachine(machines);

  return [
    {
      code: 'undeclared-capability',
      message: `${displayName} offers no machine with ${String(minCpus)} CPUs and ${String(minMemoryGb)} GB; it offers at most ${String(largest.cpus)} CPUs and ${String(largest.memoryGb)} GB`,
      fields: ['provider', 'minCpus', 'minMemoryGb'],
    },
  ];
}
