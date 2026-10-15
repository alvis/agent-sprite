import { CLAUDE_GUEST_MODULES } from './guest-modules.js';
import { claudeInstall } from './install.js';
import { CLAUDE_SPAWN_ENVIRONMENT } from './paths.js';

import type { HarnessGuestLeaf } from '#drivers/contracts';

/** the guest facts of Claude Code, readable without loading the driver */
export const claudeGuestLeaf: HarnessGuestLeaf = {
  guest: CLAUDE_GUEST_MODULES,
  install: claudeInstall,
  spawnEnvironment: CLAUDE_SPAWN_ENVIRONMENT,
};
