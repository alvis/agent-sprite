import {
  harnessDrivers,
  harnessIds,
  harnessLabel,
  mapHarnesses,
} from '#core/harnesses';
import { resolveInputs } from '#input';
import { returnOnBack, withBackNavigation } from '#navigation';
import {
  hasActions,
  hasExplicitPluginActions,
  normalizePluginOptions,
  resolvePluginActions,
  validateMarketplaceSources,
} from '#plugins';

import type { CommandOptions, Interaction } from '#command/contracts';
import type { PluginsSetupData } from '#command/data';
import type { HarnessId } from '#core/catalog';
import type { PluginActions } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { NormalizedPluginOptions } from '#plugins';

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
 * @param guest guest channel of the managed workstation
 * @param context plugin actions, prompts, and mutation state
 * @returns native plugin operation outcomes, without claiming the agent loads them
 */
export async function setupPlugins(
  guest: GuestChannel,
  context: SetupContext,
): Promise<PluginsSetupData> {
  const { options, interaction, mutation, profile } = context;
  const actions = resolvePluginActions(
    await promptPluginActions(options, profile.harnesses, interaction),
    profile.harnesses,
  );
  if (harnessIds().some((id) => actions[id].marketplaces.length)) {
    const access = await resolveInputs(options, undefined, ['githubToken']);
    const marketplaceToken =
      options.githubHost && options.githubHost.toLowerCase() !== 'github.com'
        ? undefined
        : access.githubToken;
    await validateMarketplaceSources(actions, marketplaceToken);
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
  for (const driver of harnessDrivers(profile.harnesses)) {
    if (hasActions(actions[driver.id])) {
      mutation.started = true;
      await driver.plugins.apply(guest, actions[driver.id]);
      applied.add(driver.id);
    }
  }

  return {
    plugins: mapHarnesses((driver) =>
      applied.has(driver.id) ? 'applied' : 'preserved',
    ),
  };
}

/**
 * collects repeatable native plugin mutations from the inline action menu
 * @param options existing parsed plugin actions
 * @param harnesses harnesses the workstation selects
 * @param interaction optional action prompts
 * @returns the augmented one-time plugin selections
 */
async function promptPluginActions(
  options: CommandOptions,
  harnesses: readonly HarnessId[],
  interaction?: Interaction,
): Promise<NormalizedPluginOptions> {
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
    const next = await promptOnePluginAction(selected, {
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
 * @param selected actions already chosen in this setup session
 * @param params harness preference and interactive choices
 * @param params.preferredHarness harness fixed by the caller, if selected
 * @param params.harnesses harnesses the workstation selects
 * @param params.interaction interactive native action prompts
 * @param params.yes whether destructive changes were already approved
 * @returns updated actions or an explicit finish marker
 */
async function promptOnePluginAction(
  selected: NormalizedPluginOptions,
  params: {
    preferredHarness: HarnessId | undefined;
    harnesses: readonly HarnessId[];
    interaction: Interaction;
    yes: boolean;
  },
): Promise<NormalizedPluginOptions | 'done'> {
  const { preferredHarness, harnesses, interaction, yes } = params;
  for (;;) {
    const harness =
      preferredHarness ??
      (await interaction.select<HarnessId>(
        { message: 'Select plugin harness' },
        harnessDrivers(harnesses).map((driver) => ({
          label: harnessLabel(driver.id),
          value: driver.id,
        })),
      ));
    const collect = async (): Promise<NormalizedPluginOptions | 'done'> =>
      collectHarnessAction(selected, {
        harness,
        interaction: withBackNavigation(
          interaction,
          preferredHarness ? 'back to sections' : 'back to harnesses',
        ),
        yes,
      });
    if (preferredHarness) {
      return collect();
    }
    const result = await returnOnBack(collect);
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
