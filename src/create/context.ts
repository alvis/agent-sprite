import type { CommandOptions } from '#command/contracts';
import type { ProviderDriver } from '#drivers/contracts';
import type { ResolvedInputs } from '#input/types';
import type { HarnessPluginActions } from '#integrations/native/plugin-actions';

import type { CreatePreflight } from './types.js';

export type { CreatePreflight } from './types.js';

/** values confirmed before any workstation creation attempt */
export interface CreateContext {
  options: CommandOptions;
  input: ResolvedInputs;
  name: string;
  token: string;
  effectiveExitNode?: string;
  authKey?: string;
  plugins: HarnessPluginActions;
  preflight: CreatePreflight;
  provider: ProviderDriver;
}
