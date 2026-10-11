import { returnOnBack, withBackNavigation } from '#navigation';
import { normalizePluginOptions } from '#plugins';

import type {
  CommandOptions,
  HarnessName,
  Interaction,
} from '#command/contracts';
import type { NormalizedPluginOptions } from '#integrations/native/plugin-actions';

/**
 * asks for independent Claude and Codex sources and identities during interactive create
 * @param options already parsed plugin choices and skips
 * @param interaction optional inline prompt boundary
 * @returns edited normalized one-time native selections
 */
export async function promptCreatePluginOptions(
  options: CommandOptions,
  interaction?: Interaction,
): Promise<NormalizedPluginOptions> {
  let selected = normalizePluginOptions(options);
  if (!interaction || options.nonInteractive || options.plugins === false) {
    return selected;
  }
  for (const harness of ['claude', 'codex'] as const) {
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
  params: { harness: HarnessName; interaction: Interaction; yes: boolean },
): Promise<NormalizedPluginOptions> {
  const { harness, interaction, yes } = params;
  if (yes || harnessChoicesAlreadySet(selected, harness)) {
    return selected;
  }
  const configure = await interaction.confirm({
    message: `Configure ${harness} marketplaces or plugins for this workstation?`,
  });
  if (!configure) {
    return selected;
  }
  let choices = { ...selected };
  if (
    harness === 'codex' &&
    choices.codex.marketplaces.length === 0 &&
    !choices.reuseClaudeMarketplaces &&
    choices.claude.marketplaces.length > 0
  ) {
    choices.reuseClaudeMarketplaces = await interaction.confirm({
      message:
        'Use Claude marketplace sources as editable one-time Codex defaults? Compatibility will be checked.',
    });
    choices.reuseClaudeMarketplacesSet = true;
  }
  for (;;) {
    const action = await interaction.select<'marketplace' | 'plugin' | 'done'>(
      { message: `${harness} plugin choices` },
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
            ? `${harness} marketplace source/ref`
            : `${harness} native plugin identity`,
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
 * Checks whether one harness was skipped or explicitly configured by flags.
 * @param selected normalized harness choices
 * @param harness native harness to inspect
 * @returns whether the harness choice has already been supplied
 */
function harnessChoicesAlreadySet(
  selected: NormalizedPluginOptions,
  harness: HarnessName,
): boolean {
  const choices = selected[harness];

  return (
    choices.skipped ||
    choices.marketplaces.length > 0 ||
    choices.plugins.length > 0 ||
    (harness === 'codex' && selected.reuseClaudeMarketplaces)
  );
}

interface HarnessChoice {
  harness: HarnessName;
  action: 'marketplace' | 'plugin';
  value: string;
}

/**
 * Appends one native choice without altering the other harness.
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
  const current = selected[harness];

  return {
    ...selected,
    [harness]: { ...current, [field]: [...current[field], value] },
    reuseClaudeMarketplaces:
      harness === 'codex' && action === 'marketplace'
        ? false
        : selected.reuseClaudeMarketplaces,
    reuseClaudeMarketplacesSet:
      harness === 'codex' && action === 'marketplace'
        ? true
        : selected.reuseClaudeMarketplacesSet,
  };
}
