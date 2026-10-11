import type { CommandResult } from '#command';

import type { CreateContext } from './context.js';

/** result of preflight before a provider resource exists */
export type CreatePreparation =
  | { kind: 'ready'; context: CreateContext }
  | { kind: 'result'; result: CommandResult };
