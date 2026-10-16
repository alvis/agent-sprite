import { CommandFault } from '#errors';
import { asAgent, runAsAgent } from '#integrations/guest/account';
import { AGENT_PATH } from '#integrations/guest/layout';
import { runGuestResult } from '#integrations/guest/run';
import { checkOperation } from '#operation';
import { isRecord } from '#utilities/guards';

import {
  installedPlugins,
  reconcileMarketplaces,
  recordSelectedPlugins,
} from '../shared/plugin-state.js';

import { CLAUDE_INVENTORY, CLAUDE_PLUGIN_STATE } from './paths.js';

import type { HarnessPluginControl, PluginActions } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { InstalledPlugin, PluginHarness } from '../shared/plugin-state.js';

const CLAUDE_PLUGINS: PluginHarness = {
  inventory: CLAUDE_INVENTORY,
  statePath: CLAUDE_PLUGIN_STATE,
  mutationArgs: (operation, value) => [
    'marketplace',
    operation,
    value,
    '--scope',
    'user',
    '--json',
  ],
  addedMarketplace: (source) => ({ name: source, repo: source }),
  runMutation: runClaudePlugin,
};

/**
 * reconciles selected Claude marketplaces and plugin actions via native CLI
 * @param guest target guest
 * @param actions requested native marketplace and plugin changes
 */
async function applyClaudePlugins(
  guest: GuestChannel,
  actions: PluginActions,
): Promise<void> {
  await reconcileMarketplaces(guest, {
    sources: actions.marketplaces,
    operation: 'add',
    harness: CLAUDE_PLUGINS,
  });
  await reconcileClaudePlugins(guest, actions);
  await reconcileMarketplaces(guest, {
    sources: actions.removeMarketplaces,
    operation: 'remove',
    harness: CLAUDE_PLUGINS,
  });
  await recordSelectedPlugins(guest, actions, CLAUDE_PLUGINS);
}

/**
 * applies plugin installation, enablement, disablement, and removal
 * @param guest target guest
 * @param actions requested plugin changes
 */
async function reconcileClaudePlugins(
  guest: GuestChannel,
  actions: PluginActions,
): Promise<void> {
  const installed = installedPlugins(
    (await runAsAgent(guest, ['claude', 'plugin', 'list', '--json'])).stdout,
    CLAUDE_INVENTORY,
  );
  for (const identity of actions.plugins) {
    const existing = installed.find((plugin) => plugin.id === identity);
    if (!existing) {
      await runClaudePlugin(guest, [
        'install',
        identity,
        '--scope',
        'user',
        '--json',
      ]);
    }
    if (!existing?.enabled) {
      await runClaudePlugin(guest, [
        'enable',
        identity,
        '--scope',
        'user',
        '--json',
      ]);
    }
    if (existing) {
      existing.enabled = true;
    } else {
      installed.push({ id: identity, enabled: true });
    }
  }
  await deactivateClaudePlugins(guest, actions, installed);
}

/**
 * disables and uninstalls only the explicitly selected installed plugins
 * @param guest target guest
 * @param actions requested plugin changes
 * @param installed current native inventory after installation and enablement
 */
async function deactivateClaudePlugins(
  guest: GuestChannel,
  actions: PluginActions,
  installed: InstalledPlugin[],
): Promise<void> {
  for (const identity of actions.disablePlugins) {
    const existing = installed.find((plugin) => plugin.id === identity);
    if (!existing?.enabled) {
      continue;
    }
    await runClaudePlugin(guest, [
      'disable',
      identity,
      '--scope',
      'user',
      '--json',
    ]);
    existing.enabled = false;
  }
  for (const identity of actions.uninstallPlugins) {
    const index = installed.findIndex((plugin) => plugin.id === identity);
    if (index < 0) {
      continue;
    }
    await runClaudePlugin(guest, [
      'uninstall',
      identity,
      '--scope',
      'user',
      '--json',
    ]);
    installed.splice(index, 1);
  }
}

/**
 * runs one Claude plugin mutation and checks its native result
 * @param guest target guest
 * @param args native plugin subcommand and options
 */
async function runClaudePlugin(
  guest: GuestChannel,
  args: string[],
): Promise<void> {
  const result = await runGuestResult(
    guest,
    asAgent([
      '/usr/bin/env',
      `PATH=${AGENT_PATH}`,
      'claude',
      'plugin',
      ...args,
    ]),
  );
  if (result.exitCode === 0) {
    return;
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    checkOperation();
    response = undefined;
  }
  if (isRecord(response) && response.alreadyInGoalState === true) {
    return;
  }
  throw new CommandFault({
    code: 'PROVIDER',
    message: `Claude plugin command failed with status ${result.exitCode}`,
  });
}

/** native marketplace and plugin actions of Claude Code */
export const claudePlugins: HarnessPluginControl = {
  marketplaceManifests: ['.claude-plugin/marketplace.json'],
  apply: applyClaudePlugins,
};
