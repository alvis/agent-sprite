import { harnessDrivers, mapHarnesses } from '#application/catalog/harnesses';
import { resolveInputs } from '#application/input';
import { withBackNavigation } from '#application/navigation';
import {
  hasActions,
  hasExplicitPluginActions,
  normalizePluginOptions,
  resolvePluginActions,
  validateMarketplaceSources,
} from '#application/plugins';
import { harnessIds, harnessLabel } from '#domain/harnesses';
import { returnOnBack } from '#kernel/navigation';

import type { CommandOptions } from '#application/contracts';
import type { PluginsSetupData } from '#application/data';
import type { NormalizedPluginOptions } from '#application/plugins';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { PluginActions } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { HarnessId } from '#domain/ids';

import type { SetupContext } from './context';

type PluginActionName =
  'marketplace' | 'install' | 'disable' | 'uninstall' | 'remove';

interface PluginValueParams {
  selected: NormalizedPluginOptions;
  harness: HarnessId;
  action: PluginActionName;
  interaction: Interaction;
  yes: boolean;
}

const OPTION_FOR_ACTION: Record<PluginActionName, keyof PluginActions> = {
  marketplace: 'marketplaces',
  install: 'plugins',
  disable: 'disablePlugins',
  uninstall: 'uninstallPlugins',
  remove: 'removeMarketplaces',
};

/**
 * applies independent native plugin actions for each harness
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param guest guest channel of the managed workstation
 * @param context plugin actions, prompts, and mutation state
 * @returns native plugin operation outcomes, without claiming the agent loads them
 */
export async function setupPlugins(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults' | 'host'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<PluginsSetupData> {
  const { options, interaction, mutation, profile } = context;
  const actions = resolvePluginActions(
    await promptPluginActions(dependencies, {
      options,
      harnesses: profile.harnesses,
      interaction,
    }),
    profile.harnesses,
  );
  if (harnessIds().some((id) => actions[id].marketplaces.length)) {
    const access = await resolveInputs(dependencies, {
      options,
      requirementSelection: ['githubToken'],
    });
    const marketplaceToken =
      options.githubHost && options.githubHost.toLowerCase() !== 'github.com'
        ? undefined
        : access.githubToken;
    await validateMarketplaceSources(dependencies, {
      actions,
      accessToken: marketplaceToken,
    });
  }
  if (
    options.pluginHarness &&
    harnessIds().some(
      (id) => id !== options.pluginHarness && hasActions(actions[id]),
    )
  ) {
    throw new Error(
      'Plugin actions for another harness conflict with --plugin-harness',
    );
  }

  const applied = new Set<HarnessId>();
  for (const driver of harnessDrivers(
    dependencies.registry,
    profile.harnesses,
  )) {
    if (hasActions(actions[driver.id])) {
      mutation.started = true;
      await driver.plugins.apply(guest, actions[driver.id]);
      applied.add(driver.id);
    }
  }

  return {
    plugins: mapHarnesses(dependencies.registry, (driver) =>
      applied.has(driver.id) ? 'applied' : 'preserved',
    ),
  };
}

/** the named inputs of prompt plugin actions */
interface PromptPluginActionsParams {
  /** existing parsed plugin actions */
  options: CommandOptions;
  /** harnesses the workstation selects */
  harnesses: readonly HarnessId[];
  /** optional action prompts */
  interaction?: Interaction;
}

/**
 * collects repeatable native plugin mutations from the inline action menu
 * @param dependencies the registered drivers
 * @param params the call's inputs: options, harnesses, interaction
 * @returns the augmented one-time plugin selections
 */
async function promptPluginActions(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: PromptPluginActionsParams,
): Promise<NormalizedPluginOptions> {
  const { options, harnesses, interaction } = params;
  const normalized = normalizePluginOptions(options);
  if (
    hasExplicitPluginActions(normalized) ||
    !interaction ||
    options.nonInteractive ||
    options.plugins === false
  ) {
    return normalized;
  }
  let selected = normalized;
  for (;;) {
    const next = await promptOnePluginAction(dependencies, selected, {
      preferredHarness: options.pluginHarness,
      harnesses,
      interaction,
      yes: options.yes === true,
    });
    if (next === 'done') {
      return selected;
    }
    selected = next;
  }
}

/**
 * collects one native action, including confirmation for destructive changes
 * @param dependencies the registered drivers
 * @param selected actions already chosen in this setup session
 * @param params harness preference and interactive choices
 * @param params.preferredHarness harness fixed by the caller, if selected
 * @param params.harnesses harnesses the workstation selects
 * @param params.interaction interactive native action prompts
 * @param params.yes whether destructive changes were already approved
 * @returns updated actions or an explicit finish marker
 */
async function promptOnePluginAction(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  selected: NormalizedPluginOptions,
  params: {
    preferredHarness: HarnessId | undefined;
    harnesses: readonly HarnessId[];
    interaction: Interaction;
    yes: boolean;
  },
): Promise<NormalizedPluginOptions | 'done'> {
  const { preferredHarness, harnesses, interaction, yes } = params;
  const collect = async (
    harness: HarnessId,
  ): Promise<NormalizedPluginOptions | 'done'> =>
    collectHarnessAction(selected, {
      harness,
      interaction: withBackNavigation(
        interaction,
        preferredHarness ? 'back to sections' : 'back to harnesses',
      ),
      yes,
    });
  if (preferredHarness) {
    return collect(preferredHarness);
  }
  for (;;) {
    const harness = await interaction.select<HarnessId>(
      { message: 'Select plugin harness' },
      harnessDrivers(dependencies.registry, harnesses).map((driver) => ({
        label: harnessLabel(driver.id),
        value: driver.id,
      })),
    );
    const result = await returnOnBack(async () => collect(harness));
    if (result !== undefined) {
      return result;
    }
  }
}

/**
 * collects a harness action while allowing its value prompt to return here
 * @param selected actions already queued without guest mutations
 * @param params selected harness and prompt settings
 * @param params.harness selected native harness
 * @param params.interaction prompts with a harness-menu return destination
 * @param params.yes whether destructive changes were already approved
 * @returns updated actions or an explicit finish marker
 */
async function collectHarnessAction(
  selected: NormalizedPluginOptions,
  params: { harness: HarnessId; interaction: Interaction; yes: boolean },
): Promise<NormalizedPluginOptions | 'done'> {
  const { harness, interaction, yes } = params;
  for (;;) {
    const action = await interaction.select<PluginActionName | 'done'>(
      { message: `${harnessLabel(harness)} plugin action` },
      [
        { label: 'Add marketplace', value: 'marketplace' },
        { label: 'Install and enable plugin', value: 'install' },
        { label: 'Disable plugin', value: 'disable' },
        { label: 'Uninstall plugin', value: 'uninstall' },
        { label: 'Remove marketplace', value: 'remove' },
        { label: 'Apply queued actions and finish', value: 'done' },
      ],
    );
    if (action === 'done') {
      return 'done';
    }
    const next = await returnOnBack(async () =>
      collectPluginValue({
        selected,
        harness,
        action,
        interaction: withBackNavigation(interaction, 'back to plugin actions'),
        yes,
      }),
    );
    if (next) {
      return next;
    }
  }
}

/**
 * queues one native action only after its complete input and consent
 * @param params queued actions, selected harness/action and prompts
 * @param params.harness selected native harness
 * @param params.interaction value and removal prompts
 * @returns updated queue or unchanged queue when removal is declined
 */
async function collectPluginValue(
  params: PluginValueParams,
): Promise<NormalizedPluginOptions> {
  const { selected, harness, action, interaction, yes } = params;
  const value = await interaction.input({
    message:
      action === 'marketplace' || action === 'remove'
        ? 'Native marketplace source/ref'
        : 'Native plugin identity',
    required: true,
  });
  if (
    (action === 'remove' || action === 'uninstall') &&
    !yes &&
    !(await interaction.confirm({
      message: `Remove ${value} from ${harnessLabel(harness)}? Native removal may also remove related plugins.`,
    }))
  ) {
    return selected;
  }
  const optionName = OPTION_FOR_ACTION[action];
  const current = selected.harnesses[harness];

  return {
    ...selected,
    harnesses: {
      ...selected.harnesses,
      [harness]: {
        ...current,
        [optionName]: [...current[optionName], value],
      },
    },
  };
}
