import { DEFAULT_SELECTION } from '#core/catalog';
import { networksWithDaemon, isNetworkId, networkDriver } from '#core/networks';
import { DEFAULT_PROFILE_OPTIONS } from '#core/profile';

import {
  agentChoices,
  defaultHarnesses,
  harnessChoices,
  inferNetwork,
  inferredOptions,
  networkChoices,
  providerChoices,
} from './selection-choices.js';
import {
  resolveMachine,
  resolveOptions,
  resolveRelease,
} from './selection-options.js';
import { activePrompts } from './selection-sources.js';
import { readSelection } from './selection-supplied.js';

import type { SetupSection } from '#command/contracts';
import type { ProfileCandidate, WorkstationProfile } from '#core/profile';
import type { SelectionField } from '#core/selection-inputs';

import type {
  Prompts,
  Resolved,
  SelectionContext,
} from './selection-sources.js';
import type { SuppliedSelection } from './selection-supplied.js';
import type { RequiredInput } from './types.js';

export { suppliedSelectionViolations } from './selection-supplied.js';

export type { Resolved, SelectionContext } from './selection-sources.js';
export type { SuppliedSelection } from './selection-supplied.js';

/** what an existing workstation's setup run reads before reaching the workstation */
export interface SetupReadContext extends Omit<
  SelectionContext,
  'interaction'
> {
  /** setup area the run targets */
  section: SetupSection;
}

/** what an existing workstation's setup run may change */
export interface SetupSelectionContext extends SelectionContext {
  /** the profile the workstation recorded */
  recorded: WorkstationProfile;
  /** setup area the run targets */
  section: SetupSection;
  /** values the run's flags and section-scoped environment supply */
  supplied: SuppliedSelection;
}

/** a resolved, not yet validated selection */
export interface SelectionResolution {
  /** selection to validate against the catalog */
  candidate: ProfileCandidate;
  /** environment values that could not be read */
  problems: readonly string[];
  /** whether the caller supplied the idle timeout rather than taking the default */
  isIdleTimeoutRequested: boolean;
}

/** every field a new workstation's selection reads */
const CREATE_FIELDS: readonly SelectionField[] = [
  'provider',
  'minCpus',
  'minMemoryGb',
  'agent',
  'agentRelease',
  'harnesses',
  'network',
  'isExitNodeEnabled',
  'isProxyEnabled',
  'idleTimeoutMinutes',
  'holdMaxMinutes',
  'updateCheckIntervalMinutes',
  'updateDueIntervalDays',
];

/** the fields each setup section reads and saves; every other field keeps its recorded value */
const SECTION_FIELDS: Readonly<
  Partial<Record<SetupSection, readonly SelectionField[]>>
> = {
  all: [
    'agentRelease',
    'harnesses',
    'network',
    'isExitNodeEnabled',
    'isProxyEnabled',
    'idleTimeoutMinutes',
    'holdMaxMinutes',
    'updateCheckIntervalMinutes',
    'updateDueIntervalDays',
  ],
  agent: ['agentRelease'],
  network: ['network', 'isExitNodeEnabled'],
  proxy: ['isProxyEnabled'],
  tools: ['updateCheckIntervalMinutes', 'updateDueIntervalDays'],
};

/** the machine minimums, which any setup section may carry because they resize rather than configure the guest */
const MACHINE_FIELDS: readonly SelectionField[] = ['minCpus', 'minMemoryGb'];

/**
 * lists the profile fields a setup section reads and saves
 * @param section setup area the run targets
 * @returns the owned fields; empty when the section leaves the profile unchanged
 */
export function sectionFields(
  section: SetupSection,
): readonly SelectionField[] {
  return SECTION_FIELDS[section] ?? [];
}

/**
 * resolves a new workstation's selection in dependency order: provider, ACP
 * agent, harnesses the agent supports, network, then the options the selected
 * drivers support; each step takes the flag, the environment, the selected
 * env file, a prompt, then the default, and a step with one choice is skipped;
 * every supplied value is read before the first prompt, and an unreadable one
 * suppresses prompting so it is reported at once
 * @param context flags, sources and optional prompts
 * @returns the selection and every unreadable environment value
 */
export async function resolveCreateSelection(
  context: SelectionContext,
): Promise<SelectionResolution> {
  const { options, sources } = context;
  const { value: supplied, problems } = readSelection(context, CREATE_FIELDS);
  const prompts = problems.length === 0 ? activePrompts(context) : undefined;
  const asked = {
    supplied: supplied.options,
    prompts,
    base: DEFAULT_PROFILE_OPTIONS,
  };
  const provider =
    supplied.provider ??
    (await prompts?.choose('Provider', providerChoices())) ??
    DEFAULT_SELECTION.provider;
  // the machine minimums are asked right after the provider they are checked against
  const machine = await resolveMachine({ provider, ...asked });
  const agent =
    supplied.agent ??
    (await prompts?.choose('ACP agent', agentChoices())) ??
    DEFAULT_SELECTION.agent;
  // the channel is asked right after the agent, so a later step cannot reorder it
  const agentRelease = await resolveRelease({ agent, ...asked });
  const harnesses =
    supplied.harnesses ??
    (await prompts?.chooseMany('Harnesses', harnessChoices(agent))) ??
    defaultHarnesses(agent);
  const inferred = inferNetwork(options, sources);
  const network =
    supplied.network ??
    (await prompts?.choose('Network', networkChoices(inferred))) ??
    inferred ??
    DEFAULT_SELECTION.network;

  return {
    candidate: {
      provider,
      agent,
      harnesses,
      network,
      options: await resolveOptions({
        selected: { provider, agent, harnesses, network },
        supplied: {
          ...supplied.options,
          ...machine,
          ...(agentRelease !== undefined && { agentRelease }),
        },
        fields: CREATE_FIELDS,
        prompts,
        base: DEFAULT_PROFILE_OPTIONS,
        inferred: inferredOptions(
          options,
          sources,
          isNetworkId(network) ? network : undefined,
        ),
      }),
    },
    problems,
    isIdleTimeoutRequested: supplied.options.idleTimeoutMinutes !== undefined,
  };
}

/**
 * reads the values a setup run supplies, without the recorded profile: the
 * provider and agent only from flags so a mismatch can be refused, and every
 * other field only when the targeted section owns it
 * @param context flags, sources and targeted section
 * @returns the supplied values and every unreadable environment value
 */
export function readSetupSelection(
  context: SetupReadContext,
): Resolved<SuppliedSelection> {
  return readSelection(context, [
    ...sectionFields(context.section),
    ...MACHINE_FIELDS,
  ]);
}

/**
 * merges a setup run's supplied values with the workstation's recorded
 * profile; only the fields the targeted section owns may change, and prompts
 * run only when every section is targeted
 * @param context recorded profile, targeted section, supplied values and prompts
 * @returns the selection to validate
 */
export async function resolveSetupSelection(
  context: SetupSelectionContext,
): Promise<SelectionResolution> {
  const { recorded, section, supplied } = context;
  const prompts = section === 'all' ? activePrompts(context) : undefined;
  const harnesses =
    supplied.harnesses ??
    (await prompts?.chooseMany(
      'Harnesses',
      harnessChoices(recorded.agent, recorded.harnesses),
    )) ??
    recorded.harnesses;
  const network = await resolveSetupNetwork(context, prompts);

  return {
    candidate: {
      provider: supplied.provider ?? recorded.provider,
      agent: supplied.agent ?? recorded.agent,
      harnesses,
      network,
      options: await resolveOptions({
        selected: {
          provider: recorded.provider,
          agent: recorded.agent,
          harnesses,
          network,
        },
        supplied: supplied.options,
        fields: sectionFields(section),
        prompts,
        base: recorded.options,
        enables: section === 'proxy' ? 'proxy' : undefined,
      }),
    },
    problems: [],
    isIdleTimeoutRequested: supplied.options.idleTimeoutMinutes !== undefined,
  };
}

/**
 * lists the inputs the selected network and options need before provisioning
 * @param profile resolved selection
 * @param base requirements independent of the selection
 * @param isEnrolled whether an existing network identity can be reused
 * @returns ordered requirements for aggregate preflight validation
 */
export function selectionRequirements(
  profile: WorkstationProfile,
  base: readonly RequiredInput[] = [],
  isEnrolled = false,
): RequiredInput[] {
  return [
    ...base,
    ...(networkDriver(profile.network).inputs
      ? [
          ...(isEnrolled ? [] : (['networkEnrollment'] as const)),
          'networkAccount' as const,
          ...(profile.options.isExitNodeEnabled ? (['exitNode'] as const) : []),
        ]
      : []),
    ...(profile.options.isProxyEnabled
      ? (['proxyUrl', 'proxyApiKey'] as const)
      : []),
  ];
}

/**
 * resolves the network a setup run applies; targeting the network section of a
 * workstation without one selects the first network that runs a daemon
 * @param context recorded profile, targeted section and supplied values
 * @param prompts prompts when the run targets every section
 * @returns the network id, validated later against the catalog
 */
async function resolveSetupNetwork(
  context: SetupSelectionContext,
  prompts: Prompts | undefined,
): Promise<string> {
  const { recorded, section, supplied } = context;
  const enabledNetwork =
    section === 'network' && !networkDriver(recorded.network).daemon
      ? networksWithDaemon()[0]?.id
      : undefined;

  return (
    supplied.network ??
    (await prompts?.choose('Network', networkChoices(recorded.network))) ??
    enabledNetwork ??
    recorded.network
  );
}
