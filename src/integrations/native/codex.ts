import { stringify } from 'smol-toml';

import { CommandFault } from '#errors';
import { withGuestTransaction } from '#integrations/guest/transaction';

import { configureCodexProxy } from './codex/proxy.js';
import {
  HOME,
  CODEX_CONFIG,
  ensurePrivateDirectory,
  readTomlObject,
  runAsAgent,
  writeOwnedFile,
  isRecord,
  readJsonObject,
} from './configuration.js';
import { mergeWorkHooks, workHookCommands } from './hooks.js';
import {
  installedPlugins,
  pluginHarness,
  reconcileMarketplaces,
  recordSelectedPlugins,
} from './plugin-state.js';

import type { Sprite } from '@fly/sprites';

import type { PluginActions } from './plugin-actions.js';

const CODEX_PLUGINS = pluginHarness('codex', async (sprite, args) => {
  await runAsAgent(sprite, args);
});

/**
 * merges the supported Responses provider and native model discovery into Codex TOML
 * @param sprite target guest
 * @param proxyUrl CLIProxyAPI Responses base URL
 * @param apiKey gateway credential
 */
export async function configureCodex(
  sprite: Sprite,
  proxyUrl?: string,
  apiKey?: string,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    if (Boolean(proxyUrl) !== Boolean(apiKey)) {
      throw new CommandFault({
        code: 'INPUT',
        message: 'Codex proxy URL and API key must be supplied together',
      });
    }
    await ensurePrivateDirectory(sprite, `${HOME}/.codex`);
    const current = await readTomlObject(sprite, CODEX_CONFIG);
    await configureCodexProxy({ sprite, current, proxyUrl, apiKey });
    await configureCodexHooks(sprite);
  });
}

/**
 * installs and narrowly trusts only agent-sprite's own user-level Codex hooks
 * @param sprite target guest
 */
async function configureCodexHooks(sprite: Sprite): Promise<void> {
  const hooksPath = `${HOME}/.codex/hooks.json`;
  const existingHooks = await readJsonObject(sprite, hooksPath);
  await writeOwnedFile(
    sprite,
    hooksPath,
    `${JSON.stringify(
      {
        ...existingHooks,
        hooks: mergeWorkHooks(existingHooks.hooks, 'codex'),
      },
      null,
      2,
    )}\n`,
  );
  await runAsAgent(sprite, [
    '/opt/agent-sprite/node/bin/node',
    '/opt/agent-sprite/codex-hooks-trust.js',
    ...Object.values(workHookCommands('codex')),
  ]);
}

/**
 * reconciles selected Codex marketplaces and plugin actions via native CLI and TOML
 * @param sprite target guest
 * @param actions requested native marketplace and plugin changes
 */
export async function applyCodexPlugins(
  sprite: Sprite,
  actions: PluginActions,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    await reconcileMarketplaces(sprite, {
      sources: actions.marketplaces,
      operation: 'add',
      harness: CODEX_PLUGINS,
    });
    await reconcileCodexPlugins(sprite, actions);
    await reconcileMarketplaces(sprite, {
      sources: actions.removeMarketplaces,
      operation: 'remove',
      harness: CODEX_PLUGINS,
    });
    await setCodexPluginEnablement(sprite, actions);
    await recordSelectedPlugins(sprite, actions, CODEX_PLUGINS);
  });
}

/**
 * installs or removes only the requested native Codex plugin identities
 * @param sprite target guest
 * @param actions requested plugin changes
 */
async function reconcileCodexPlugins(
  sprite: Sprite,
  actions: PluginActions,
): Promise<void> {
  const installed = installedPlugins(
    (await runAsAgent(sprite, ['codex', 'plugin', 'list', '--json'])).stdout,
    'codex',
  );
  for (const identity of actions.plugins) {
    if (!installed.some((plugin) => plugin.id === identity)) {
      await runAsAgent(sprite, ['codex', 'plugin', 'add', identity, '--json']);
      installed.push({ id: identity, enabled: true });
    }
  }
  for (const identity of actions.uninstallPlugins) {
    const index = installed.findIndex((plugin) => plugin.id === identity);
    if (index < 0) {
      continue;
    }
    await runAsAgent(sprite, ['codex', 'plugin', 'remove', identity, '--json']);
    installed.splice(index, 1);
  }
}

/**
 * reconciles selected enablement while preserving other Codex plugin config
 * @param sprite target guest
 * @param actions requested plugin changes
 */
async function setCodexPluginEnablement(
  sprite: Sprite,
  actions: PluginActions,
): Promise<void> {
  if (actions.plugins.length || actions.disablePlugins.length) {
    const current = await readTomlObject(sprite, CODEX_CONFIG);
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
      sprite,
      CODEX_CONFIG,
      stringify({ ...current, plugins: nextPlugins }),
    );
  }
}
