import { harnessPluginOptions } from '#cli/harness-flags';

import type { HarnessPluginFlagValues } from '#cli/harness-flags';
import type { CommandOptions } from '#command';

/**
 * builds command options from per-harness plugin flags as the CLI parses them
 * @param values ordinary options and per-harness plugin flag values
 * @returns options carrying the per-harness selections
 */
export function pluginFlags(
  values: Omit<CommandOptions, 'harnessPlugins'> & HarnessPluginFlagValues,
): CommandOptions {
  const {
    claudePlugins,
    codexPlugins,
    claudeMarketplace,
    codexMarketplace,
    claudePlugin,
    codexPlugin,
    removeClaudeMarketplace,
    removeCodexMarketplace,
    disableClaudePlugin,
    disableCodexPlugin,
    uninstallClaudePlugin,
    uninstallCodexPlugin,
    ...options
  } = values;
  const harnessPlugins = harnessPluginOptions({
    claudePlugins,
    codexPlugins,
    claudeMarketplace,
    codexMarketplace,
    claudePlugin,
    codexPlugin,
    removeClaudeMarketplace,
    removeCodexMarketplace,
    disableClaudePlugin,
    disableCodexPlugin,
    uninstallClaudePlugin,
    uninstallCodexPlugin,
  });

  return { ...options, harnessPlugins };
}
