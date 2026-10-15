import { CLAUDE_SPAWN_ENVIRONMENT } from './paths.js';
import { claudeTool } from './tools.js';

import type { HarnessGuestLeaf } from '#drivers/contracts';

/** the guest facts of Claude Code, readable without loading the driver */
export const claudeGuestLeaf: HarnessGuestLeaf = {
  guest: [],
  tools: [claudeTool],
  spawnEnvironment: CLAUDE_SPAWN_ENVIRONMENT,
};
