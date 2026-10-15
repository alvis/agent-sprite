import { CLAUDE_GUEST_MODULES } from './guest-modules.js';
import { CLAUDE_SPAWN_ENVIRONMENT } from './paths.js';
import { claudeTool } from './tools.js';

import type { HarnessGuestLeaf } from '#drivers/contracts';

/** the guest facts of Claude Code, readable without loading the driver */
export const claudeGuestLeaf: HarnessGuestLeaf = {
  guest: CLAUDE_GUEST_MODULES,
  tools: [claudeTool],
  spawnEnvironment: CLAUDE_SPAWN_ENVIRONMENT,
};
