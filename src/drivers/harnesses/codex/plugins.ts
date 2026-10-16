import { stringify } from 'smol-toml';

import { runAsAgent, writeOwnedFile } from '#integrations/guest/account';
import { readTomlObject } from '#integrations/native/configuration';
import { isRecord } from '#utilities/guards';

import {
  installedPlugins,
  reconcileMarketplaces,
  recordSelectedPlugins,
} from '../shared/plugin-state';

import { CODEX_CONFIG, CODEX_INVENTORY, CODEX_PLUGIN_STATE } from './paths';

import type { HarnessPluginControl, PluginActions } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { PluginHarness } from '../shared/plugin-state';

const CODEX_PLUGINS: PluginHarness = {
  inventory: CODEX_INVENTORY,
  statePath: CODEX_PLUGIN_STATE,
  mutationArgs: (operation, value) => [
    'codex',
    'plugin',
    'marketplace',
    operation,
    value,
    '--json',
  ],
  addedMarketplace: (source) => ({
    name: source,
    marketplaceSource: { source },
  }),
  runMutation: async (guest, args) => {
    await runAsAgent(guest, args);
  },
};

/**
 * reconciles selected Codex marketplaces and plugin actions via native CLI and TOML
 * @param guest target guest
 * @param actions requested native marketplace and plugin changes
 */
async function applyCodexPlugins(
  guest: GuestChannel,
  actions: PluginActions,
): Promise<void> {
  await reconcileMarketplaces(guest, {
    sources: actions.marketplaces,
    operation: 'add',
    harness: CODEX_PLUGINS,
  });
  await reconcileCodexPlugins(guest, actions);
  await reconcileMarketplaces(guest, {
    sources: actions.removeMarketplaces,
    operation: 'remove',
    harness: CODEX_PLUGINS,
  });
  await setCodexPluginEnablement(guest, actions);
  await recordSelectedPlugins(guest, actions, CODEX_PLUGINS);
}

/**
 * installs or removes only the requested native Codex plugin identities
 * @param guest target guest
 * @param actions requested plugin changes
 */
async function reconcileCodexPlugins(
  guest: GuestChannel,
  actions: PluginActions,
): Promise<void> {
  const installed = installedPlugins(
    (await runAsAgent(guest, ['codex', 'plugin', 'list', '--json'])).stdout,
    CODEX_INVENTORY,
  );
  for (const identity of actions.plugins) {
    if (!installed.some((plugin) => plugin.id === identity)) {
      await runAsAgent(guest, ['codex', 'plugin', 'add', identity, '--json']);
      installed.push({ id: identity, enabled: true });
    }
  }
  for (const identity of actions.uninstallPlugins) {
    const index = installed.findIndex((plugin) => plugin.id === identity);
    if (index < 0) {
      continue;
    }
    await runAsAgent(guest, ['codex', 'plugin', 'remove', identity, '--json']);
    installed.splice(index, 1);
  }
}

/**
 * reconciles selected enablement while preserving other Codex plugin config
 * @param guest target guest
 * @param actions requested plugin changes
 */
async function setCodexPluginEnablement(
  guest: GuestChannel,
  actions: PluginActions,
): Promise<void> {
  if (actions.plugins.length || actions.disablePlugins.length) {
    const current = await readTomlObject(guest, CODEX_CONFIG);
    const plugins = isRecord(current.plugins) ? current.plugins : {};
    const nextPlugins: Record<string, unknown> = { ...plugins };
    for (const identity of actions.plugins) {
      const previous = isRecord(nextPlugins[identity])
        ? nextPlugins[identity]
        : {};
      nextPlugins[identity] = { ...previous, enabled: true };
    }
    for (const identity of actions.disablePlugins) {
      const previous = isRecord(nextPlugins[identity])
        ? nextPlugins[identity]
        : {};
      nextPlugins[identity] = { ...previous, enabled: false };
    }
    await writeOwnedFile(
      guest,
      CODEX_CONFIG,
      stringify({ ...current, plugins: nextPlugins }),
    );
  }
}

/** native marketplace and plugin actions of Codex */
export const codexPlugins: HarnessPluginControl = {
  marketplaceManifests: [
    '.agents/plugins/marketplace.json',
    '.agents/plugins/api_marketplace.json',
    '.claude-plugin/marketplace.json',
    '.cursor-plugin/marketplace.json',
  ],
  apply: applyCodexPlugins,
};
