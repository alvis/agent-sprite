import { harnessLabel } from '#core/harnesses';
import { returnOnBack, withBackNavigation } from '#navigation';
import { marketplaceSourceHarness, normalizePluginOptions } from '#plugins';

import type { CommandOptions, Interaction } from '#command/contracts';
import type { HarnessId } from '#core/catalog';
import type { HarnessPluginActions, NormalizedPluginOptions } from '#plugins';

/**
 * describes the native choices of every selected harness for the creation review
 * @param plugins native marketplace and plugin actions per harness
 * @param harnesses selected harnesses
 * @returns one review line per harness
 */
export function describePluginSelections(
  plugins: HarnessPluginActions,
  harnesses: readonly HarnessId[],
): string[] {
  const describe = (choices: string[]): string =>
    choices.length ? choices.join(', ') : 'none';

  return harnesses.map(
    (id) =>
      `${harnessLabel(id)} marketplaces: ${describe(plugins[id].marketplaces)}; plugins: ${describe(plugins[id].plugins)}`,
  );
}

/**
 * asks for independent sources and identities of each selected harness during interactive create
 * @param options already parsed plugin choices and skips
 * @param harnesses selected harnesses, in catalog order
 * @param interaction optional inline prompt boundary
 * @returns edited normalized one-time native selections
 */
export async function promptCreatePluginOptions(
  options: CommandOptions,
  harnesses: readonly HarnessId[],
  interaction?: Interaction,
): Promise<NormalizedPluginOptions> {
  let selected = normalizePluginOptions(options);
  if (!interaction || options.nonInteractive || options.plugins === false) {
    return selected;
  }
  for (const harness of harnesses) {
    selected = await promptHarnessChoices(selected, {
      harness,
      interaction,
      yes: options.yes === true,
    });
  }

  return selected;
}

/**
 * gathers marketplace and plugin choices for one native harness
 * @param selected existing independent harness selections
 * @param params native harness and prompt settings
 * @param params.harness native harness receiving new selections
 * @param params.interaction inline prompts for optional selections
 * @param params.yes whether prompts were already approved
 * @returns updated selections for one harness
 */
async function promptHarnessChoices(
  selected: NormalizedPluginOptions,
  params: { harness: HarnessId; interaction: Interaction; yes: boolean },
): Promise<NormalizedPluginOptions> {
  const { harness, interaction, yes } = params;
  if (yes || harnessChoicesAlreadySet(selected, harness)) {
    return selected;
  }
  const configure = await interaction.confirm({
    message: `Configure ${harnessLabel(harness)} marketplaces or plugins for this workstation?`,
  });
  if (!configure) {
    return selected;
  }
  let choices = { ...selected };
  const source = marketplaceSourceHarness(choices);
  if (
    source &&
    source !== harness &&
    choices.harnesses[harness].marketplaces.length === 0 &&
    !choices.reuseMarketplaces
  ) {
    choices.reuseMarketplaces = await interaction.confirm({
      message: `Use ${harnessLabel(source)} marketplace sources as editable one-time ${harnessLabel(harness)} defaults? Compatibility will be checked.`,
    });
    choices.reuseMarketplacesSet = true;
  }
  for (;;) {
    const action = await interaction.select<'marketplace' | 'plugin' | 'done'>(
      { message: `${harnessLabel(harness)} plugin choices` },
      [
        { label: 'Add marketplace source', value: 'marketplace' },
        { label: 'Install and enable a plugin identity', value: 'plugin' },
        { label: 'Done', value: 'done' },
      ],
    );
    if (action === 'done') {
      return choices;
    }
    const value = await returnOnBack(async () =>
      withBackNavigation(interaction, 'back to plugin choices').input({
        message:
          action === 'marketplace'
            ? `${harnessLabel(harness)} marketplace source/ref`
            : `${harnessLabel(harness)} native plugin identity`,
        required: true,
      }),
    );
    if (value !== undefined) {
      choices = appendHarnessChoice(choices, {
        harness,
        action: action === 'marketplace' ? 'marketplace' : 'plugin',
        value,
      });
    }
  }
}

/**
 * checks whether one harness was skipped or explicitly configured by flags
 * @param selected normalized harness choices
 * @param harness native harness to inspect
 * @returns whether the harness choice has already been supplied
 */
function harnessChoicesAlreadySet(
  selected: NormalizedPluginOptions,
  harness: HarnessId,
): boolean {
  const choices = selected.harnesses[harness];

  return (
    choices.skipped ||
    choices.marketplaces.length > 0 ||
    choices.plugins.length > 0 ||
    (selected.reuseMarketplaces &&
      marketplaceSourceHarness(selected) !== harness)
  );
}

interface HarnessChoice {
  harness: HarnessId;
  action: 'marketplace' | 'plugin';
  value: string;
}

/**
 * appends one native choice without altering the other harness
 * @param selected normalized choices before this new value
 * @param choice one native marketplace or plugin choice
 * @returns augmented normalized choices
 */
function appendHarnessChoice(
  selected: NormalizedPluginOptions,
  choice: HarnessChoice,
): NormalizedPluginOptions {
  const { harness, action, value } = choice;
  const field = action === 'marketplace' ? 'marketplaces' : 'plugins';
  const current = selected.harnesses[harness];
  const source = marketplaceSourceHarness(selected);
  // a harness's own marketplace replaces the sources it would have reused
  const isOverride =
    action === 'marketplace' && source !== undefined && source !== harness;

  return {
    ...selected,
    harnesses: {
      ...selected.harnesses,
      [harness]: { ...current, [field]: [...current[field], value] },
    },
    reuseMarketplaces: isOverride ? false : selected.reuseMarketplaces,
    reuseMarketplacesSet: isOverride ? true : selected.reuseMarketplacesSet,
  };
}
