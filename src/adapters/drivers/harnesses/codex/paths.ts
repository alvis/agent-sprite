import { AGENT_HOME, GUEST_ROOT } from '#adapters/guest/platform/layout';
import { isRecord } from '#kernel/guards';

import type { PluginInventory } from '#adapters/drivers/harnesses/shared/plugin-state';

/** the Codex configuration directory, also its `CODEX_HOME` */
export const CODEX_HOME = `${AGENT_HOME}/.codex`;

/** environment the ACP agent passes when spawning Codex */
export const CODEX_SPAWN_ENVIRONMENT: Readonly<Record<string, string>> = {
  CODEX_HOME,
};

/** model-gateway variables Codex reads, owned by its proxy configuration */
export const CODEX_RESERVED_ENVIRONMENT = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;

/** the Codex user configuration */
export const CODEX_CONFIG = `${CODEX_HOME}/config.toml`;

/** private file holding the CLIProxyAPI credential Codex reads */
export const CODEX_TOKEN = `${CODEX_HOME}/cliproxyapi-token`;

/** the Codex user hook definitions */
export const CODEX_HOOKS = `${CODEX_HOME}/hooks.json`;

/** open-agent's record of the Codex plugin identities it manages */
export const CODEX_PLUGIN_STATE = `${GUEST_ROOT}/codex-plugins.json`;

/** shape of the Codex CLI's plugin and marketplace inventories */
export const CODEX_INVENTORY: PluginInventory = {
  name: 'codex',
  pluginIdKey: 'pluginId',
  pluginEntries: (decoded) => (isRecord(decoded) ? decoded.installed : decoded),
  marketplaceEntries: (decoded) =>
    isRecord(decoded) ? decoded.marketplaces : decoded,
};
