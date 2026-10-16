import { configureClaude } from './configure.js';
import { claudeHooks } from './hooks.js';
import { claudeReadiness, inspectClaude } from './inspect.js';
import {
  CLAUDE_RESERVED_ENVIRONMENT,
  CLAUDE_SPAWN_ENVIRONMENT,
} from './paths.js';
import { claudePlugins } from './plugins.js';
import { claudeTool } from './tools.js';

import type { HarnessDriver } from '#drivers/contracts';

import type { ClaudeInitialization } from './initialization.js';

/** Claude Code as a harness driver */
export const claude: HarnessDriver<'claude', ClaudeInitialization | undefined> =
  {
    id: 'claude',
    kind: 'harnesses',
    displayName: 'Claude Code',
    supportsProxy: true,
    tools: [claudeTool],
    spawnEnvironment: CLAUDE_SPAWN_ENVIRONMENT,
    plugins: claudePlugins,
    hooks: claudeHooks,
    reservedEnvironment: CLAUDE_RESERVED_ENVIRONMENT,
    configure: configureClaude,
    inspect: inspectClaude,
    readiness: claudeReadiness,
  };
