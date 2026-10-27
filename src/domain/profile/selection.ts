import { selectionLabel } from '#domain/selection-inputs';

import type { ProductDeclarations } from '#domain/declarations';
import type { AgentId, DriverId, DriverKind, HarnessId } from '#domain/ids';

import type {
  ProfileCandidate,
  ProfileValidationOptions,
  ProfileViolation,
} from '../profile';

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
