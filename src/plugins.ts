import { classifyMarketplaceSource } from '#integrations/marketplaces';

import { CommandFault } from './errors.js';

import type { CommandOptions, HarnessName } from '#command/contracts';

import type {
  PluginActions,
  HarnessPluginActions,
  HarnessPluginOptions,
  NormalizedPluginOptions,
} from '#integrations/native/plugin-actions';

export type {
  PluginActions,
  HarnessPluginActions,
} from '#integrations/native/plugin-actions';

/**
 * Converts flat CLI plugin flags into one per-harness input record.
 * @param options flat public CLI plugin options
 * @returns normalized per-harness inputs
 */
export function normalizePluginOptions(
  options: CommandOptions,
): NormalizedPluginOptions {
  return {
    claude: {
      skipped: options.claudePlugins === false,
      marketplaces: options.claudeMarketplace ?? [],
      plugins: options.claudePlugin ?? [],
      removeMarketplaces: options.removeClaudeMarketplace ?? [],
      disablePlugins: options.disableClaudePlugin ?? [],
      uninstallPlugins: options.uninstallClaudePlugin ?? [],
    },
    codex: {
      skipped: options.codexPlugins === false,
      marketplaces: options.codexMarketplace ?? [],
      plugins: options.codexPlugin ?? [],
      removeMarketplaces: options.removeCodexMarketplace ?? [],
      disablePlugins: options.disableCodexPlugin ?? [],
      uninstallPlugins: options.uninstallCodexPlugin ?? [],
    },
    noPlugins: options.plugins === false,
    reuseClaudeMarketplaces: options.reuseClaudeMarketplaces === true,
    reuseClaudeMarketplacesSet: options.reuseClaudeMarketplaces !== undefined,
  };
}

/**
 * Resolves explicit changes without treating a skip as a removal.
 * @param options flat or normalized plugin choices
 * @returns validated native actions for each harness
 */
export function resolvePluginActions(
  options: CommandOptions | NormalizedPluginOptions,
): HarnessPluginActions {
  const selected =
    'claude' in options && 'codex' in options
      ? options
      : normalizePluginOptions(options);
  const { claude, codex } = selected;
  if (
    selected.noPlugins &&
    (hasActions(claude) ||
      hasActions(codex) ||
      selected.reuseClaudeMarketplaces)
  ) {
    throw new CommandFault({
      code: 'USAGE',
      message: '--no-plugins conflicts with explicit plugin actions',
    });
  }
  if (claude.skipped && hasActions(claude)) {
    throw new CommandFault({
      code: 'USAGE',
      message:
        '--no-claude-plugins conflicts with explicit Claude plugin actions',
    });
  }
  if (
    codex.skipped &&
    (hasActions(codex) || selected.reuseClaudeMarketplaces)
  ) {
    throw new CommandFault({
      code: 'USAGE',
      message:
        '--no-codex-plugins conflicts with explicit Codex plugin actions',
    });
  }
  if (selected.reuseClaudeMarketplaces && codex.marketplaces.length > 0) {
    throw new CommandFault({
      code: 'USAGE',
      message:
        '--reuse-claude-marketplaces conflicts with explicit Codex marketplaces',
    });
  }

  return {
    claude:
      selected.noPlugins || claude.skipped ? emptyActions() : actions(claude),
    codex:
      selected.noPlugins || codex.skipped
        ? emptyActions()
        : {
            ...actions(codex),
            marketplaces: selected.reuseClaudeMarketplaces
              ? claude.marketplaces
              : codex.marketplaces,
          },
  };
}

/**
 * Checks whether explicit plugin mutations require the plugins setup section.
 * @param options public CLI flags
 * @returns whether explicit native plugin actions were requested
 */
export function hasExplicitPluginActions(
  options: CommandOptions | NormalizedPluginOptions,
): boolean {
  const selected =
    'claude' in options && 'codex' in options
      ? options
      : normalizePluginOptions(options);

  return (
    hasActions(selected.claude) ||
    hasActions(selected.codex) ||
    selected.reuseClaudeMarketplaces
  );
}

/**
 * Removes prompt-only skip state from one harness's native action request.
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
  for (const harness of ['claude', 'codex'] as const) {
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
  harness: HarnessName,
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
  harness: HarnessName,
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
