import type { HarnessId } from '#core/catalog';
import type { PluginActions } from '#drivers/contracts';

/** native marketplace and plugin changes for one harness */
export type { PluginActions };

/** independently selected native actions for every harness */
export type HarnessPluginActions = Record<HarnessId, PluginActions>;

/** parsed choices for one harness before skip and inheritance are applied */
export interface HarnessPluginOptions extends PluginActions {
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
