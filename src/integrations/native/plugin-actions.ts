/** native plugin changes for one harness. Empty arrays preserve existing state */
export interface PluginActions {
  marketplaces: string[];
  plugins: string[];
  removeMarketplaces: string[];
  disablePlugins: string[];
  uninstallPlugins: string[];
}

/** independently selected Claude and Codex actions */
export interface HarnessPluginActions {
  claude: PluginActions;
  codex: PluginActions;
}

/** Parsed choices for one harness before skip and inheritance are applied. */
export interface HarnessPluginOptions extends PluginActions {
  skipped: boolean;
}

/** One-time normalized plugin input shared by create and setup prompts. */
export interface NormalizedPluginOptions {
  claude: HarnessPluginOptions;
  codex: HarnessPluginOptions;
  noPlugins: boolean;
  reuseClaudeMarketplaces: boolean;
  reuseClaudeMarketplacesSet: boolean;
}
