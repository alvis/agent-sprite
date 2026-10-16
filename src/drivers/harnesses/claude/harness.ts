import { configureClaude } from './configure';
import { claudeHooks } from './hooks';
import { claudeReadiness, inspectClaude } from './inspect';
import { CLAUDE_RESERVED_ENVIRONMENT, CLAUDE_SPAWN_ENVIRONMENT } from './paths';
import { claudePlugins } from './plugins';
import { claudeTool } from './tools';

import type { HarnessDriver } from '#drivers/contracts';

import type { ClaudeInitialization } from './initialization';

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
