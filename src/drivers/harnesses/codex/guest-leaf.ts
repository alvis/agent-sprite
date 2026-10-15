import { CODEX_SPAWN_ENVIRONMENT } from './paths.js';
import { codexTool } from './tools.js';

import type { HarnessGuestLeaf } from '#drivers/contracts';

/** the guest facts of Codex, readable without loading the driver */
export const codexGuestLeaf: HarnessGuestLeaf = {
  guest: [],
  tools: [codexTool],
  spawnEnvironment: CODEX_SPAWN_ENVIRONMENT,
};
