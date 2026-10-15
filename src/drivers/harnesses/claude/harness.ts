import { configureClaude } from './configure.js';
import { claudeGuestLeaf } from './guest-leaf.js';
import { claudeHooks } from './hooks.js';
import { claudeReadiness, inspectClaude } from './inspect.js';
import { CLAUDE_RESERVED_ENVIRONMENT } from './paths.js';
import { claudePlugins } from './plugins.js';

import type { HarnessDriver } from '#drivers/contracts';

import type { ClaudeInitialization } from './inspect.js';

/** Claude Code as a harness driver */
export const claude: HarnessDriver<'claude', ClaudeInitialization | undefined> =
  {
    id: 'claude',
    kind: 'harnesses',
    displayName: 'Claude Code',
    supportsProxy: true,
    ...claudeGuestLeaf,
    plugins: claudePlugins,
    hooks: claudeHooks,
    reservedEnvironment: CLAUDE_RESERVED_ENVIRONMENT,
    configure: configureClaude,
    inspect: inspectClaude,
    readiness: claudeReadiness,
  };
