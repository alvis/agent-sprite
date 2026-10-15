import { catalog } from '#core/catalog';
import { isHarnessId } from '#core/harnesses';
import { isNetworkId } from '#core/networks';
import { isDriverId } from '#core/profile';
import { machineViolations } from '#core/profile-rules';

import { releaseChoices } from './selection-choices.js';

import type { ProfileOptions } from '#core/profile';
import type { SelectionField } from '#core/selection-inputs';

import type { Prompts } from './selection-sources.js';
import type { SuppliedSelection } from './selection-supplied.js';

/** facts the option steps depend on */
export interface OptionContext {
  /** drivers already selected */
  selected: {
    provider: string;
    agent: string;
    harnesses: readonly string[];
    network: string;
  };
  /** options the caller supplied */
  supplied: SuppliedSelection['options'];
  /** fields the run owns; every other option keeps its base value */
  fields: readonly SelectionField[];
  prompts?: Prompts;
  /** recorded options for setup, default options for a new workstation */
  base: ProfileOptions;
  /** options inferred from supplied inputs, also the prompt defaults */
  inferred?: { isExitNodeEnabled: boolean; isProxyEnabled: boolean };
  /** option the targeted setup section turns on unless a flag says otherwise */
  enables?: 'proxy';
}

/**
 * resolves the capability-driven options the run owns: exit node only when
 * the network supports one, CLIProxyAPI only when a selected harness supports
 * it, idle minutes only when the provider keeps workstations awake; hold-max
 * and the update intervals are never asked
 * @param context selected drivers, supplied values, prompts and base options
 * @returns the profile options
 */
export async function resolveOptions(
  context: OptionContext,
): Promise<ProfileOptions> {
  const { base, fields, supplied } = context;

  const agentRelease = fields.includes('agentRelease')
    ? await resolveRelease({ ...context, agent: context.selected.agent })
    : base.agentRelease;

  return {
    ...base,
    ...(agentRelease !== undefined && { agentRelease }),
    isExitNodeEnabled: fields.includes('isExitNodeEnabled')
      ? await resolveExitNode(context)
      : base.isExitNodeEnabled,
    isProxyEnabled: fields.includes('isProxyEnabled')
      ? await resolveProxy(context)
      : base.isProxyEnabled,
    idleTimeoutMinutes: fields.includes('idleTimeoutMinutes')
      ? await resolveIdleMinutes(context)
      : base.idleTimeoutMinutes,
    minCpus: supplied.minCpus ?? base.minCpus,
    minMemoryGb: supplied.minMemoryGb ?? base.minMemoryGb,
    holdMaxMinutes: supplied.holdMaxMinutes ?? base.holdMaxMinutes,
    updateCheckIntervalMinutes:
      supplied.updateCheckIntervalMinutes ?? base.updateCheckIntervalMinutes,
    updateDueIntervalDays:
      supplied.updateDueIntervalDays ?? base.updateDueIntervalDays,
  };
}

/**
 * resolves the release channel the ACP agent follows: the supplied one, else
 * the one the base options record, else the agent's default; asked only when
 * the agent declares more than one channel
 * @param context agent, supplied values, prompts and base options
 * @returns the channel, absent when the agent declares none and none was recorded
 */
export async function resolveRelease(
  context: Pick<OptionContext, 'supplied' | 'prompts' | 'base'> & {
    agent: string;
  },
): Promise<string | undefined> {
  const { agent, supplied, prompts, base } = context;
  if (supplied.agentRelease !== undefined) {
    return supplied.agentRelease;
  }
  const channels = isDriverId('agents', agent)
    ? catalog.agents[agent].releaseChannels
    : undefined;
  if (channels === undefined) {
    return base.agentRelease;
  }
  const current = base.agentRelease ?? channels.defaultChannel;

  return (
    (await prompts?.choose(
      'Release channel',
      releaseChoices(channels, current),
    )) ?? current
  );
}

/**
 * resolves the minimum machine size of a new workstation: the supplied
 * minimums, else the base ones, with each missing one asked for CPUs first and
 * memory second; a prompt asks again while the provider offers no machine
 * that meets the answer
 * @param context provider, supplied values, prompts and base options
 * @returns the CPU and memory minimums
 */
export async function resolveMachine(
  context: Pick<OptionContext, 'supplied' | 'prompts' | 'base'> & {
    provider: string;
  },
): Promise<Pick<ProfileOptions, 'minCpus' | 'minMemoryGb'>> {
  const { provider, supplied, prompts, base } = context;
  const refusal = (
    requirement: Pick<ProfileOptions, 'minCpus' | 'minMemoryGb'>,
  ): string | undefined =>
    isDriverId('providers', provider)
      ? machineViolations(provider, { ...base, ...requirement })[0]?.message
      : undefined;
  const minCpus =
    supplied.minCpus ??
    (await prompts?.number('Minimum CPUs', base.minCpus, {
      unit: 'CPUs',
      minimum: 1,
      check: (value) => refusal({ minCpus: value, minMemoryGb: 1 }),
    })) ??
    base.minCpus;
  const minMemoryGb =
    supplied.minMemoryGb ??
    (await prompts?.number('Minimum memory (GB)', base.minMemoryGb, {
      unit: 'GB',
      minimum: 1,
      check: (value) => refusal({ minCpus, minMemoryGb: value }),
    })) ??
    base.minMemoryGb;

  return { minCpus, minMemoryGb };
}

/**
 * resolves whether egress uses an exit node, asked only when the network supports one
 * @param context selected drivers, supplied values and prompts
 * @returns whether an exit node is used
 */
async function resolveExitNode(context: OptionContext): Promise<boolean> {
  const { selected, supplied, prompts, inferred, base } = context;
  if (supplied.isExitNodeEnabled !== undefined) {
    return supplied.isExitNodeEnabled;
  }
  if (
    !isNetworkId(selected.network) ||
    !catalog.networks[selected.network].supportsExitNode
  ) {
    return false;
  }
  const fallback = inferred?.isExitNodeEnabled ?? base.isExitNodeEnabled;

  return (await prompts?.confirm('Use an exit node?', fallback)) ?? fallback;
}

/**
 * resolves whether harnesses use CLIProxyAPI, asked only when a selected harness supports it
 * @param context selected drivers, supplied values, prompts and the section's implied option
 * @returns whether the model gateway is used
 */
async function resolveProxy(context: OptionContext): Promise<boolean> {
  const { selected, supplied, prompts, inferred, base } = context;
  const explicit =
    supplied.isProxyEnabled ?? (context.enables === 'proxy' ? true : undefined);
  if (explicit !== undefined) {
    return explicit;
  }
  if (
    !selected.harnesses.some(
      (id) => isHarnessId(id) && catalog.harnesses[id].supportsProxy,
    )
  ) {
    return false;
  }
  const fallback = inferred?.isProxyEnabled ?? base.isProxyEnabled;

  return (
    (await prompts?.confirm(
      'Route harnesses through CLIProxyAPI?',
      fallback,
    )) ?? fallback
  );
}

/**
 * resolves idle minutes, asked only when the provider keeps workstations awake
 * @param context selected drivers, supplied values and prompts
 * @returns minutes before suspension, 0 for never
 */
async function resolveIdleMinutes(context: OptionContext): Promise<number> {
  const { selected, supplied, prompts, base } = context;
  if (supplied.idleTimeoutMinutes !== undefined) {
    return supplied.idleTimeoutMinutes;
  }
  const keepsAwake = isDriverId('providers', selected.provider)
    ? catalog.providers[selected.provider].capabilities.keepAwakeMode !== 'none'
    : false;

  return (
    (keepsAwake
      ? await prompts?.number(
          'Suspend after idle (minutes, 0 = never)',
          base.idleTimeoutMinutes,
        )
      : undefined) ?? base.idleTimeoutMinutes
  );
}
