import { harnessIds, harnessLabel } from '#core/harnesses';
import { classifyMarketplaceSource } from '#integrations/marketplaces';
import { recordOf } from '#utilities/records';

import { CommandFault } from './errors.js';

import type { CommandOptions } from '#command/contracts';
import type { HarnessId } from '#core/catalog';

import type { PluginActions } from '#drivers/contracts';

/** independently selected native actions for every harness */
export type HarnessPluginActions = Record<HarnessId, PluginActions>;

/** parsed choices for one harness before skip and inheritance are applied */
interface HarnessPluginOptions extends PluginActions {
  /** whether the harness's plugins were explicitly skipped */
  skipped: boolean;
}

/** one-time normalized plugin input shared by create and setup prompts */
export interface NormalizedPluginOptions {
  /** whether every native plugin was skipped (`--no-plugins`) or chosen per harness */
  kind: 'skipped' | 'selected';
  /** parsed choices of every catalog harness, keyed by harness id */
  harnesses: Record<HarnessId, HarnessPluginOptions>;
  /** whether harnesses without their own marketplaces reuse the first harness's sources */
  reuseMarketplaces: boolean;
  /** whether the reuse choice was made explicitly */
  reuseMarketplacesSet: boolean;
}

/**
 * converts parsed plugin flags into one input record per harness
 * @param options parsed CLI plugin options keyed by harness id
 * @returns normalized per-harness inputs
 */
export function normalizePluginOptions(
  options: CommandOptions,
): NormalizedPluginOptions {
  return {
    kind: options.plugins === false ? 'skipped' : 'selected',
    harnesses: recordOf(harnessIds(), (id) => {
      const selected = options.harnessPlugins?.[id];

      return {
        skipped: selected?.isEnabled === false,
        marketplaces: selected?.marketplaces ?? [],
        plugins: selected?.plugins ?? [],
        removeMarketplaces: selected?.removeMarketplaces ?? [],
        disablePlugins: selected?.disablePlugins ?? [],
        uninstallPlugins: selected?.uninstallPlugins ?? [],
      };
    }),
    reuseMarketplaces: options.reuseMarketplaces === true,
    reuseMarketplacesSet: options.reuseMarketplaces !== undefined,
  };
}

/**
 * names the harness whose marketplace sources the others reuse
 * @param selected normalized choices
 * @returns the first harness, in catalog order, with selected marketplaces
 */
export function marketplaceSourceHarness(
  selected: NormalizedPluginOptions,
): HarnessId | undefined {
  return harnessIds().find(
    (id) => selected.harnesses[id].marketplaces.length > 0,
  );
}

/**
 * resolves explicit changes without treating a skip as a removal
 * @param selected normalized plugin choices
 * @param harnesses selected harnesses; actions for any other harness are refused
 * @returns validated native actions for each harness
 */
export function resolvePluginActions(
  selected: NormalizedPluginOptions,
  harnesses: readonly HarnessId[] = harnessIds(),
): HarnessPluginActions {
  assertPluginChoices(selected, harnesses);
  const source = marketplaceSourceHarness(selected);

  return recordOf(harnessIds(), (id) => {
    const own = selected.harnesses[id];
    if (selected.kind === 'skipped' || own.skipped || !harnesses.includes(id)) {
      return emptyActions();
    }

    return {
      ...actions(own),
      marketplaces:
        selected.reuseMarketplaces && source && own.marketplaces.length === 0
          ? selected.harnesses[source].marketplaces
          : own.marketplaces,
    };
  });
}

/**
 * rejects plugin choices that contradict each other or the selected harnesses
 * @param selected normalized choices
 * @param harnesses selected harnesses
 * @throws {CommandFault} for the first conflicting choice
 */
function assertPluginChoices(
  selected: NormalizedPluginOptions,
  harnesses: readonly HarnessId[],
): void {
  const conflict = (message: string): never => {
    throw new CommandFault({ code: 'USAGE', message });
  };
  const withActions = harnessIds().filter((id) =>
    hasActions(selected.harnesses[id]),
  );
  if (
    selected.kind === 'skipped' &&
    (withActions.length > 0 || selected.reuseMarketplaces)
  ) {
    conflict('--no-plugins conflicts with explicit plugin actions');
  }
  for (const id of withActions) {
    if (selected.harnesses[id].skipped) {
      conflict(
        `--no-${id}-plugins conflicts with explicit ${harnessLabel(id)} plugin actions`,
      );
    }
    if (!harnesses.includes(id)) {
      conflict(
        `${harnessLabel(id)} plugin actions need ${harnessLabel(id)} to be a selected harness (--harness ${id})`,
      );
    }
  }
  if (
    selected.reuseMarketplaces &&
    harnessIds().filter((id) => selected.harnesses[id].marketplaces.length > 0)
      .length > 1
  ) {
    conflict(
      '--reuse-marketplaces conflicts with marketplaces chosen for more than one harness',
    );
  }
}

/**
 * checks whether explicit plugin mutations require the plugins setup section
 * @param selected normalized plugin choices
 * @returns whether explicit native plugin actions were requested
 */
export function hasExplicitPluginActions(
  selected: NormalizedPluginOptions,
): boolean {
  return (
    harnessIds().some((id) => hasActions(selected.harnesses[id])) ||
    selected.reuseMarketplaces
  );
}

/**
 * removes prompt-only skip state from one harness's native action request
 * @param selected one normalized harness choice
 * @returns native actions without prompt-only skip state
 */
function actions(selected: HarnessPluginOptions): PluginActions {
  const { skipped: _skipped, ...actions } = selected;

  return actions;
}

/**
 * checks whether a harness has an actual requested native change
 * @param actions actions for one native harness
 * @returns whether any marketplace or plugin mutation is requested
 */
export function hasActions(actions: PluginActions): boolean {
  return (
    actions.marketplaces.length > 0 ||
    actions.plugins.length > 0 ||
    actions.removeMarketplaces.length > 0 ||
    actions.disablePlugins.length > 0 ||
    actions.uninstallPlugins.length > 0
  );
}

/**
 * rejects unverified selected sources before provisioning or native changes
 * @param actions marketplace selections for each harness
 * @param accessToken optional selected GitHub credential for private sources
 * @param requireSelectedPluginCoverage require every selected identity in selected manifests
 * @returns when every selected source has a recognized native manifest
 */
export async function validateMarketplaceSources(
  actions: HarnessPluginActions,
  accessToken?: string,
  requireSelectedPluginCoverage = false,
): Promise<void> {
  for (const harness of harnessIds()) {
    const available = await validateHarnessMarketplaces(
      actions[harness].marketplaces,
      harness,
      accessToken,
    );
    if (requireSelectedPluginCoverage) {
      ensureSelectedPluginCoverage(
        actions[harness].plugins,
        available,
        harness,
      );
    }
  }
}

/**
 * inspects each selected manifest before any native or provider mutation
 * @param sources selected native marketplace references
 * @param harness native harness consuming the manifests
 * @param accessToken optional GitHub credential for private sources
 * @returns exact plugin identities available from compatible manifests
 */
async function validateHarnessMarketplaces(
  sources: string[],
  harness: HarnessId,
  accessToken?: string,
): Promise<Set<string>> {
  const available = new Set<string>();
  for (const source of sources) {
    if (/^https?:\/\//.test(source)) {
      const url = new URL(source);
      if (url.username || url.password) {
        throw new CommandFault({
          code: 'INPUT',
          message: `${harness} marketplace URL must not contain credentials`,
        });
      }
    }
    const result = await classifyMarketplaceSource(
      source,
      harness,
      accessToken,
    );
    if (result.compatibility !== 'supported') {
      const message = `${harness} marketplace ${source}: ${result.compatibility} (${result.reason})`;
      throw new CommandFault({ code: 'INPUT', message });
    }
    for (const pluginName of result.pluginNames ?? []) {
      available.add(`${pluginName}@${result.marketplaceName}`);
    }
  }

  return available;
}

/**
 * rejects identities absent from the selected compatible manifests
 * @param selected exact plugin identities to install
 * @param available identities declared by the selected manifests
 * @param harness native harness consuming the manifests
 */
function ensureSelectedPluginCoverage(
  selected: string[],
  available: Set<string>,
  harness: HarnessId,
): void {
  for (const identity of selected) {
    if (!available.has(identity)) {
      const message = `${harness} plugin ${identity} is absent from selected compatible marketplace manifests`;
      throw new CommandFault({ code: 'INPUT', message });
    }
  }
}

/**
 * makes empty native actions that preserve existing settings
 * @returns actions with no marketplace or plugin mutations
 */
function emptyActions(): PluginActions {
  return {
    marketplaces: [],
    plugins: [],
    removeMarketplaces: [],
    disablePlugins: [],
    uninstallPlugins: [],
  };
}
