import {
  networksWithDaemon,
  networkDriver,
} from '#application/catalog/networks';

import {
  agentChoices,
  defaultHarnesses,
  harnessChoices,
  inferNetwork,
  inferredOptions,
  networkChoices,
  providerChoices,
} from './selection/choices';
import {
  resolveMachine,
  resolveOptions,
  resolveRelease,
} from './selection/options';
import { activePrompts } from './selection/sources';
import { readSelection } from './selection/supplied';

import type { SetupSection } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { NetworkId } from '#domain/ids';
import type { ProfileCandidate, WorkstationProfile } from '#domain/profile';
import type { SelectionField } from '#domain/selection-inputs';

import type { Prompts, Resolved, SelectionContext } from './selection/sources';
import type { SuppliedSelection } from './selection/supplied';
import type { RequiredInput } from './types';

/** what an existing workstation's setup run reads before reaching the workstation */
interface SetupReadContext extends Omit<SelectionContext, 'interaction'> {
  /** setup area the run targets */
  section: SetupSection;
}

/** what an existing workstation's setup run may change */
interface SetupSelectionContext extends SelectionContext {
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
    'updateDueIntervalDays',
  ],
  agent: ['agentRelease'],
  network: ['network', 'isExitNodeEnabled'],
  proxy: ['isProxyEnabled'],
  tools: ['updateDueIntervalDays'],
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

/** the named inputs of resolveCreateNetwork */
interface CreateNetworkParams {
  /** network named by a flag or the environment */
  supplied: string | undefined;
  /** network the supplied inputs select */
  inferred: NetworkId | undefined;
  /** active prompts, absent when none may be asked */
  prompts: Prompts | undefined;
}

/**
 * resolves the network of a new workstation: the supplied value, a prompt, the
 * network the supplied inputs select, then the default
 * @param dependencies the registered drivers, the profile defaults
 * @param params the call's inputs: supplied, inferred, prompts
 * @returns the selected network
 */
async function resolveCreateNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  params: CreateNetworkParams,
): Promise<string> {
  const { supplied, inferred, prompts } = params;

  return (
    supplied ??
    (await prompts?.choose(
      'Network',
      networkChoices(dependencies, inferred),
    )) ??
    inferred ??
    dependencies.defaults.selection.network
  );
}

/**
 * reads the values a create run supplies
 * @param dependencies the registered drivers, which declare the selection inputs
 * @param context flags and sources
 * @returns the supplied values and every unreadable environment value
 */
function readCreateSelection(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  context: Omit<SelectionContext, 'interaction'>,
): Resolved<SuppliedSelection> {
  return readSelection(dependencies, context, CREATE_FIELDS);
}

/**
 * resolves a new workstation's selection in dependency order: provider, ACP
 * agent, harnesses the agent supports, network, then the options the selected
 * drivers support; each step takes the flag, the environment, the selected
 * credential file, a prompt, then the default, and a step with one choice is skipped;
 * every supplied value is read before the first prompt, and an unreadable one
 * suppresses prompting so it is reported at once
 * @param dependencies the registered drivers, the profile defaults
 * @param context flags, sources and optional prompts
 * @returns the selection and every unreadable environment value
 */
export async function resolveCreateSelection(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  context: SelectionContext,
): Promise<SelectionResolution> {
  const { options, sources } = context;
  const { value: supplied, problems } = readCreateSelection(
    dependencies,
    context,
  );
  const prompts = problems.length === 0 ? activePrompts(context) : undefined;
  const asked = {
    supplied: supplied.options,
    prompts,
    base: dependencies.defaults.options,
  };
  const provider =
    supplied.provider ??
    (await prompts?.choose('Provider', providerChoices(dependencies))) ??
    dependencies.defaults.selection.provider;
  // the machine minimums are asked right after the provider they are checked against
  const machine = await resolveMachine(dependencies, { provider, ...asked });
  const agent =
    supplied.agent ??
    (await prompts?.choose('ACP agent', agentChoices(dependencies))) ??
    dependencies.defaults.selection.agent;
  // the channel is asked right after the agent, so a later step cannot reorder it
  const agentRelease = await resolveRelease(dependencies, { agent, ...asked });
  const harnesses =
    supplied.harnesses ??
    (await prompts?.chooseMany(
      'Harnesses',
      harnessChoices(dependencies, agent),
    )) ??
    defaultHarnesses(dependencies, agent);
  const network = await resolveCreateNetwork(dependencies, {
    supplied: supplied.network,
    inferred: inferNetwork(dependencies, options, sources),
    prompts,
  });

  return {
    candidate: {
      provider,
      agent,
      harnesses,
      network,
      options: await resolveOptions(dependencies, {
        selected: { provider, agent, harnesses, network },
        supplied: {
          ...supplied.options,
          ...machine,
          ...(agentRelease !== undefined && { agentRelease }),
        },
        fields: CREATE_FIELDS,
        prompts,
        base: dependencies.defaults.options,
        inferred: inferredOptions(dependencies, { options, sources, network }),
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
 * @param dependencies the registered drivers, which declare the selection inputs
 * @param context flags, sources and targeted section
 * @returns the supplied values and every unreadable environment value
 */
export function readSetupSelection(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  context: SetupReadContext,
): Resolved<SuppliedSelection> {
  return readSelection(dependencies, context, [
    ...sectionFields(context.section),
    ...MACHINE_FIELDS,
  ]);
}

/**
 * merges a setup run's supplied values with the workstation's recorded
 * profile; only the fields the targeted section owns may change, and prompts
 * run only when every section is targeted
 * @param dependencies the registered drivers, the profile defaults
 * @param context recorded profile, targeted section, supplied values and prompts
 * @returns the selection to validate
 */
export async function resolveSetupSelection(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  context: SetupSelectionContext,
): Promise<SelectionResolution> {
  const { recorded, section, supplied } = context;
  const prompts = section === 'all' ? activePrompts(context) : undefined;
  const harnesses =
    supplied.harnesses ??
    (await prompts?.chooseMany(
      'Harnesses',
      harnessChoices(dependencies, recorded.agent, recorded.harnesses),
    )) ??
    recorded.harnesses;
  const network = await resolveSetupNetwork(dependencies, context, prompts);

  return {
    candidate: {
      provider: supplied.provider ?? recorded.provider,
      agent: supplied.agent ?? recorded.agent,
      harnesses,
      network,
      options: await resolveOptions(dependencies, {
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

/** the named inputs of selection requirements */
export interface SelectionRequirementsParams {
  /** resolved selection */
  profile: WorkstationProfile;
  /** requirements independent of the selection */
  base?: readonly RequiredInput[];
  /** whether an existing network identity can be reused */
  isEnrolled?: boolean;
}

/**
 * lists the inputs the selected network and options need before provisioning
 * @param dependencies the registered drivers
 * @param params the call's inputs: profile, base, isEnrolled
 * @returns ordered requirements for aggregate preflight validation
 */
export function selectionRequirements(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: SelectionRequirementsParams,
): RequiredInput[] {
  const { profile, base = [], isEnrolled = false } = params;

  return [
    ...base,
    ...(networkDriver(dependencies.registry, profile.network).inputs
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
 * @param dependencies the registered drivers, the profile defaults
 * @param context recorded profile, targeted section and supplied values
 * @param prompts prompts when the run targets every section
 * @returns the network id, validated later against the catalog
 */
async function resolveSetupNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  context: SetupSelectionContext,
  prompts: Prompts | undefined,
): Promise<string> {
  const { recorded, section, supplied } = context;
  const enabledNetwork =
    section === 'network' &&
    !networkDriver(dependencies.registry, recorded.network).daemon
      ? networksWithDaemon(dependencies.registry)[0]?.id
      : undefined;

  return (
    supplied.network ??
    (await prompts?.choose(
      'Network',
      networkChoices(dependencies, recorded.network),
    )) ??
    enabledNetwork ??
    recorded.network
  );
}
