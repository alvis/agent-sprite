import { CommandFault } from '#errors';

import { writeGuestFile } from '#integrations/guest';

import {
  CLAUDE_PLUGIN_STATE,
  CODEX_PLUGIN_STATE,
  isRecord,
  readSelectedPlugins,
  runAsAgent,
} from './configuration.js';

import type { Sprite } from '@fly/sprites';

import type { PluginActions } from './plugin-actions.js';

type Harness = 'claude' | 'codex';

/** Native command and state differences needed by the shared reconciliation. */
export interface PluginHarness {
  name: Harness;
  statePath: string;
  mutationArgs: (operation: 'add' | 'remove', value: string) => string[];
  addedMarketplace: (source: string) => Record<string, unknown>;
  runMutation: (sprite: Sprite, args: string[]) => Promise<void>;
}

/**
 * Preserve each CLI's native command shape and selected-file location.
 * @param name selected native harness
 * @param runMutation harness-specific mutation runner
 * @returns native command and state descriptor
 */
export function pluginHarness(
  name: Harness,
  runMutation: PluginHarness['runMutation'],
): PluginHarness {
  return {
    name,
    statePath: name === 'claude' ? CLAUDE_PLUGIN_STATE : CODEX_PLUGIN_STATE,
    mutationArgs: (operation, value) =>
      name === 'claude'
        ? ['marketplace', operation, value, '--scope', 'user', '--json']
        : ['codex', 'plugin', 'marketplace', operation, value, '--json'],
    addedMarketplace: (source) =>
      name === 'claude'
        ? { name: source, repo: source }
        : { name: source, marketplaceSource: { source } },
    runMutation,
  };
}

/**
 * Reconcile marketplace additions or removals against a fresh native list.
 * @param sprite target guest
 * @param params selected sources, operation and harness
 * @param params.sources marketplace sources or names
 * @param params.operation add or remove
 * @param params.harness native command and state descriptor
 */
export async function reconcileMarketplaces(
  sprite: Sprite,
  params: {
    sources: readonly string[];
    operation: 'add' | 'remove';
    harness: PluginHarness;
  },
): Promise<void> {
  const { sources, operation, harness } = params;
  const current = marketplaces(
    (
      await runAsAgent(sprite, [
        harness.name,
        'plugin',
        'marketplace',
        'list',
        '--json',
      ])
    ).stdout,
    harness.name,
  );
  for (const source of sources) {
    const index = current.findIndex((entry) =>
      marketplaceMatches(entry, source),
    );
    if (operation === 'add') {
      if (index >= 0) {
        continue;
      }
      await harness.runMutation(
        sprite,
        harness.mutationArgs(operation, source),
      );
      current.push(harness.addedMarketplace(source));
    } else {
      if (index < 0) {
        continue;
      }
      await harness.runMutation(
        sprite,
        harness.mutationArgs(operation, String(current[index]!.name)),
      );
      current.splice(index, 1);
    }
  }
}

/**
 * Keep only previously managed or newly requested identities still enabled.
 * @param sprite target guest
 * @param actions selected plugin changes
 * @param harness native command and state descriptor
 */
export async function recordSelectedPlugins(
  sprite: Sprite,
  actions: PluginActions,
  harness: PluginHarness,
): Promise<void> {
  const previous = await readSelectedPlugins(sprite, harness.statePath);
  const native = installedPlugins(
    (await runAsAgent(sprite, [harness.name, 'plugin', 'list', '--json']))
      .stdout,
    harness.name,
  );
  const enabled = new Set(
    native.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
  );
  const selected = [...new Set([...previous, ...actions.plugins])].filter(
    (identity) => enabled.has(identity),
  );
  await writeGuestFile(sprite, {
    path: harness.statePath,
    contents: `${JSON.stringify(selected)}\n`,
    mode: 0o644,
  });
}

/** exact installed native plugin record needed for repeatable setup */
export interface InstalledPlugin {
  id: string;
  enabled: boolean;
}

/**
 * parses the native installed-plugin inventory without accepting partial output
 * @param output JSON emitted by the selected native CLI
 * @param harness selected harness
 * @returns installed plugin identities and enablement
 */
export function installedPlugins(
  output: string,
  harness: 'claude' | 'codex',
): InstalledPlugin[] {
  const parsed = parseNativeInventory(output, harness, 'plugin');
  const entries =
    harness === 'codex' && isRecord(parsed) ? parsed.installed : parsed;
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof (harness === 'codex' ? entry.pluginId : entry.id) === 'string' &&
        typeof entry.enabled === 'boolean',
    )
  ) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Native ${harness} plugin list was malformed`,
    });
  }

  return entries.map((entry: Record<string, unknown>) => ({
    id: String(harness === 'codex' ? entry.pluginId : entry.id),
    enabled: entry.enabled === true,
  }));
}

/**
 * compares a native marketplace record to a requested GitHub source or name
 * @param entry one native marketplace list entry
 * @param source requested source or marketplace name
 * @returns whether the native record refers to that source
 */
export function marketplaceMatches(entry: unknown, source: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  if (entry.name === source) {
    return true;
  }

  const nativeSource = isRecord(entry.marketplaceSource)
    ? entry.marketplaceSource.source
    : entry.repo;

  return (
    typeof nativeSource === 'string' &&
    normalizeGithubSource(nativeSource) === normalizeGithubSource(source)
  );
}

/**
 * parses the native marketplace inventory without treating invalid output as empty
 * @param output JSON emitted by the selected native CLI
 * @param harness selected harness
 * @returns marketplace records
 */
export function marketplaces(
  output: string,
  harness: 'claude' | 'codex',
): Array<Record<string, unknown>> {
  const parsed = parseNativeInventory(output, harness, 'marketplace');
  const entries =
    harness === 'codex' && isRecord(parsed) ? parsed.marketplaces : parsed;
  if (!Array.isArray(entries) || !entries.every(isRecord)) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Native ${harness} marketplace list was malformed`,
    });
  }

  return entries;
}

/**
 * parses native CLI inventory without exposing the command's raw output
 * @param output native CLI JSON output
 * @param harness selected native harness
 * @param kind inventory type for a safe public diagnostic
 * @returns parsed inventory for shape validation
 */
function parseNativeInventory(
  output: string,
  harness: 'claude' | 'codex',
  kind: 'plugin' | 'marketplace',
): unknown {
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Native ${harness} ${kind} list was malformed`,
      cause,
      causeVisibility: 'private',
    });
  }
}

/**
 * normalizes equivalent GitHub repository identities for source comparison
 * @param source GitHub URL or owner/repository identity
 * @returns normalized owner/repository identity
 */
function normalizeGithubSource(source: string): string {
  return source
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}
