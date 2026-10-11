import { CommandFault } from '#errors';
import { runGuestResult } from '#integrations/guest';
import { withGuestTransaction } from '#integrations/guest/transaction';
import { checkOperation } from '#operation';

import {
  removeClaudeProxyOwnership,
  resolveClaudeProxy,
} from './claude/proxy.js';
import {
  USER,
  HOME,
  AGENT_PATH,
  CLAUDE_SETTINGS,
  ensurePrivateDirectory,
  readJsonObject,
  runAsAgent,
  writeOwnedFile,
  isRecord,
} from './configuration.js';
import { mergeWorkHooks } from './hooks.js';
import {
  installedPlugins,
  pluginHarness,
  reconcileMarketplaces,
  recordSelectedPlugins,
} from './plugin-state.js';

import type { Sprite } from '@fly/sprites';

import type { PluginActions } from './plugin-actions.js';

import type { InstalledPlugin } from './plugin-state.js';

const CLAUDE_PLUGINS = pluginHarness('claude', runClaudePlugin);

/**
 * applies base hooks and optional managed proxy routing to Claude user settings
 * @param sprite target guest
 * @param proxyUrl CLIProxyAPI gateway base URL
 * @param apiKey gateway credential
 */
export async function configureClaude(
  sprite: Sprite,
  proxyUrl?: string,
  apiKey?: string,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    if (Boolean(proxyUrl) !== Boolean(apiKey)) {
      throw new CommandFault({
        code: 'INPUT',
        message: 'Claude proxy URL and API key must be supplied together',
      });
    }
    await ensurePrivateDirectory(sprite, `${HOME}/.claude`);
    const current = await readJsonObject(sprite, CLAUDE_SETTINGS);
    const previousEnv = isRecord(current.env) ? current.env : {};
    const proxy = await resolveClaudeProxy({
      sprite,
      current: previousEnv,
      proxyUrl,
      apiKey,
    });
    const next = {
      ...current,
      env: {
        ...proxy.env,
        DISABLE_AUTOUPDATER: '1',
      },
      hooks: mergeWorkHooks(current.hooks, 'claude'),
    };
    await writeOwnedFile(
      sprite,
      CLAUDE_SETTINGS,
      `${JSON.stringify(next, null, 2)}\n`,
    );
    if (proxy.removeOwnership) {
      await removeClaudeProxyOwnership(sprite);
    }
  });
}

/**
 * reconciles selected Claude marketplaces and plugin actions via native CLI
 * @param sprite target guest
 * @param actions requested native marketplace and plugin changes
 */
export async function applyClaudePlugins(
  sprite: Sprite,
  actions: PluginActions,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    await reconcileMarketplaces(sprite, {
      sources: actions.marketplaces,
      operation: 'add',
      harness: CLAUDE_PLUGINS,
    });
    await reconcileClaudePlugins(sprite, actions);
    await reconcileMarketplaces(sprite, {
      sources: actions.removeMarketplaces,
      operation: 'remove',
      harness: CLAUDE_PLUGINS,
    });
    await recordSelectedPlugins(sprite, actions, CLAUDE_PLUGINS);
  });
}

/**
 * applies plugin installation, enablement, disablement, and removal
 * @param sprite target guest
 * @param actions requested plugin changes
 */
async function reconcileClaudePlugins(
  sprite: Sprite,
  actions: PluginActions,
): Promise<void> {
  const installed = installedPlugins(
    (await runAsAgent(sprite, ['claude', 'plugin', 'list', '--json'])).stdout,
    'claude',
  );
  for (const identity of actions.plugins) {
    const existing = installed.find((plugin) => plugin.id === identity);
    if (!existing) {
      await runClaudePlugin(sprite, [
        'install',
        identity,
        '--scope',
        'user',
        '--json',
      ]);
    }
    if (!existing?.enabled) {
      await runClaudePlugin(sprite, [
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
  await deactivateClaudePlugins(sprite, actions, installed);
}

/**
 * disables and uninstalls only the explicitly selected installed plugins
 * @param sprite target guest
 * @param actions requested plugin changes
 * @param installed current native inventory after installation and enablement
 */
async function deactivateClaudePlugins(
  sprite: Sprite,
  actions: PluginActions,
  installed: InstalledPlugin[],
): Promise<void> {
  for (const identity of actions.disablePlugins) {
    const existing = installed.find((plugin) => plugin.id === identity);
    if (!existing?.enabled) {
      continue;
    }
    await runClaudePlugin(sprite, [
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
    await runClaudePlugin(sprite, [
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
 * @param sprite target guest
 * @param args native plugin subcommand and options
 */
async function runClaudePlugin(sprite: Sprite, args: string[]): Promise<void> {
  const result = await runGuestResult(sprite, [
    '/usr/sbin/runuser',
    '-u',
    USER,
    '--',
    '/usr/bin/env',
    `PATH=${AGENT_PATH}`,
    'claude',
    'plugin',
    ...args,
  ]);
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
