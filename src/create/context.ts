import type { SpritesClient } from '@fly/sprites';

import type { CommandOptions } from '#command/contracts';
import type { ResolvedInputs } from '#input/types';
import type { GuestIntegrations } from '#integrations/guest/types';
import type { HarnessPluginActions } from '#integrations/native/plugin-actions';

import type { CreatePreflight } from './types.js';

export type { CreatePreflight } from './types.js';

/** values confirmed before any Sprite creation attempt */
export interface CreateContext {
  options: CommandOptions;
  input: ResolvedInputs;
  name: string;
  token: string;
  integrations: GuestIntegrations;
  effectiveExitNode?: string;
  authKey?: string;
  plugins: HarnessPluginActions;
  preflight: CreatePreflight;
  client: SpritesClient;
}
