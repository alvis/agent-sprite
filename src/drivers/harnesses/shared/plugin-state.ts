import { CommandFault } from '#errors';
import { runGuestResult, writeGuestFile } from '#integrations/guest';
import {
  AGENT_PATH,
  asAgent,
  isRecord,
  readSelectedPlugins,
  runAsAgent,
} from '#integrations/native/configuration';

import type { PluginActions } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GuestCommandResult } from '#integrations/guest/types';

/** how one native CLI shapes its decoded plugin and marketplace inventories */
export interface PluginInventory {
  /** executable name, also used in diagnostics */
  name: string;
  /** field holding each plugin's identity */
  pluginIdKey: string;
  /** selects the plugin array from the decoded plugin list */
  pluginEntries: (decoded: unknown) => unknown;
  /** selects the marketplace array from the decoded marketplace list */
  marketplaceEntries: (decoded: unknown) => unknown;
}

/** native command and state differences the shared reconciliation needs */
export interface PluginHarness {
  /** how the native CLI shapes its inventories */
  inventory: PluginInventory;
  /** guest file recording the plugin identities open-agent manages */
  statePath: string;
  /** builds the native subcommand arguments for one marketplace change */
  mutationArgs: (operation: 'add' | 'remove', value: string) => string[];
  /** describes the marketplace record a successful add leaves behind */
  addedMarketplace: (source: string) => Record<string, unknown>;
  /** runs one native mutation and checks its result */
  runMutation: (guest: GuestChannel, args: string[]) => Promise<void>;
}

/**
 * reconciles marketplace additions or removals against a fresh native list
 * @param guest target guest
 * @param params selected sources, operation and harness
 * @param params.sources marketplace sources or names
 * @param params.operation add or remove
 * @param params.harness native command and state descriptor
 */
export async function reconcileMarketplaces(
  guest: GuestChannel,
  params: {
    sources: readonly string[];
    operation: 'add' | 'remove';
    harness: PluginHarness;
  },
): Promise<void> {
  const { sources, operation, harness } = params;
  const current = marketplaces(
    (
      await runAsAgent(guest, [
        harness.inventory.name,
        'plugin',
        'marketplace',
        'list',
        '--json',
      ])
    ).stdout,
    harness.inventory,
  );
  for (const source of sources) {
    const index = current.findIndex((entry) =>
      marketplaceMatches(entry, source),
    );
    if (operation === 'add') {
      if (index >= 0) {
        continue;
      }
      await harness.runMutation(guest, harness.mutationArgs(operation, source));
      current.push(harness.addedMarketplace(source));
    } else {
      if (index < 0) {
        continue;
      }
      await harness.runMutation(
        guest,
        harness.mutationArgs(operation, String(current[index]!.name)),
      );
      current.splice(index, 1);
    }
  }
}

/**
 * keeps only previously managed or newly requested identities still enabled
 * @param guest target guest
 * @param actions selected plugin changes
 * @param harness native command and state descriptor
 */
export async function recordSelectedPlugins(
  guest: GuestChannel,
  actions: PluginActions,
  harness: PluginHarness,
): Promise<void> {
  const previous = await readSelectedPlugins(guest, harness.statePath);
  const native = installedPlugins(
    (
      await runAsAgent(guest, [
        harness.inventory.name,
        'plugin',
        'list',
        '--json',
      ])
    ).stdout,
    harness.inventory,
  );
  const enabled = new Set(
    native.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
  );
  const selected = [...new Set([...previous, ...actions.plugins])].filter(
    (identity) => enabled.has(identity),
  );
  await writeGuestFile(guest, {
    path: harness.statePath,
    contents: `${JSON.stringify(selected)}\n`,
    mode: 0o644,
  });
}

/** exact installed native plugin record needed for repeatable setup */
export interface InstalledPlugin {
  /** native plugin identity */
  id: string;
  /** whether the plugin is enabled */
  enabled: boolean;
}

/**
 * parses the native installed-plugin inventory without accepting partial output
 * @param output JSON emitted by the selected native CLI
 * @param inventory the native CLI's inventory shape
 * @returns installed plugin identities and enablement
 */
export function installedPlugins(
  output: string,
  inventory: PluginInventory,
): InstalledPlugin[] {
  const entries = inventory.pluginEntries(
    parseNativeInventory(output, inventory.name, 'plugin'),
  );
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry[inventory.pluginIdKey] === 'string' &&
        typeof entry.enabled === 'boolean',
    )
  ) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Native ${inventory.name} plugin list was malformed`,
    });
  }

  return entries.map((entry: Record<string, unknown>) => ({
    id: String(entry[inventory.pluginIdKey]),
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
 * @param inventory the native CLI's inventory shape
 * @returns marketplace records
 */
export function marketplaces(
  output: string,
  inventory: PluginInventory,
): Array<Record<string, unknown>> {
  const entries = inventory.marketplaceEntries(
    parseNativeInventory(output, inventory.name, 'marketplace'),
  );
  if (!Array.isArray(entries) || !entries.every(isRecord)) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Native ${inventory.name} marketplace list was malformed`,
    });
  }

  return entries;
}

/**
 * parses native CLI inventory without exposing the command's raw output
 * @param output native CLI JSON output
 * @param name native executable name
 * @param kind inventory type for a safe public diagnostic
 * @returns parsed inventory for shape validation
 */
function parseNativeInventory(
  output: string,
  name: string,
  kind: 'plugin' | 'marketplace',
): unknown {
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Native ${name} ${kind} list was malformed`,
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

/**
 * probes native plugin-list availability without changing native state
 * @param guest target guest
 * @param inventory the native CLI whose plugin list is probed
 * @returns guest command result
 */
export async function listNativePlugins(
  guest: GuestChannel,
  inventory: PluginInventory,
): Promise<GuestCommandResult> {
  return runGuestResult(
    guest,
    asAgent([
      '/usr/bin/env',
      `PATH=${AGENT_PATH}`,
      inventory.name,
      'plugin',
      'list',
      '--json',
    ]),
  );
}

/**
 * requires every selected identity to remain installed and enabled natively
 * @param result native plugin list result
 * @param inventory the native CLI's inventory shape
 * @param selected managed selected identities
 * @returns whether native inventory confirms all selected plugins
 */
export function enabledSelections(
  result: GuestCommandResult,
  inventory: PluginInventory,
  selected: string[],
): boolean {
  if (result.exitCode !== 0) {
    return false;
  }
  try {
    const enabled = new Set(
      installedPlugins(result.stdout, inventory)
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.id),
    );

    return selected.every((identity) => enabled.has(identity));
  } catch {
    return false;
  }
}
