import { AGENT_HOME, GUEST_ROOT } from '#integrations/guest/layout';

import type { PluginInventory } from '../shared/plugin-state.js';

/** Claude Code user settings, including environment and hooks */
export const CLAUDE_SETTINGS = `${AGENT_HOME}/.claude/settings.json`;

/** open-agent's record of the Claude plugin identities it manages */
export const CLAUDE_PLUGIN_STATE = `${GUEST_ROOT}/claude-plugins.json`;

/** Claude Code configuration directory */
export const CLAUDE_CONFIG_DIR = `${AGENT_HOME}/.claude`;

/** environment the ACP agent passes when spawning Claude Code */
export const CLAUDE_SPAWN_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_CONFIG_DIR,
};

/** model-gateway variables Claude Code reads, owned by its proxy configuration */
export const CLAUDE_RESERVED_ENVIRONMENT = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/** shape of the Claude CLI's plugin and marketplace inventories */
export const CLAUDE_INVENTORY: PluginInventory = {
  name: 'claude',
  pluginIdKey: 'id',
  pluginEntries: (decoded) => decoded,
  marketplaceEntries: (decoded) => decoded,
};
