import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isProviderComponent } from '../component-catalog.js';
import { isRecord } from '../records.js';

import { storedIdleOptions } from './options.js';

import type { ProviderComponent } from '../../drivers/component-types.js';

import type { IdleOptions } from './options.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The host writes the provider it recorded and the stored profile;
// this reads them back field by field and never fails the caller

/** the recorded provider and the stored idle options */
export interface Settings {
  /** the provider, when the host recorded a valid one */
  provider?: ProviderComponent;
  /** the stored idle options */
  options: IdleOptions;
  /** why anything defaulted */
  diagnostics: string[];
}

/**
 * reads the recorded provider and the stored idle options, each field by
 * field, never failing the recompute
 * @param root directory the catalog and the manifest are in
 * @returns the provider when valid, the options, and why anything defaulted
 */
export async function readSettings(root: string): Promise<Settings> {
  const diagnostics: string[] = [];
  const catalog = await readJson(join(root, 'components.json'));
  const recorded = isRecord(catalog) ? catalog.provider : undefined;
  if (recorded === undefined) {
    diagnostics.push('no provider is recorded yet, so only state is recorded');
  } else if (!isProviderComponent(recorded)) {
    diagnostics.push(
      'the recorded provider is malformed, so only state is recorded',
    );
  } else if (
    recorded.keepAwakeMode !== 'none' &&
    recorded.awakeAdapter === undefined
  ) {
    diagnostics.push(
      'the provider declares no awake adapter, so only state is recorded',
    );
  }
  const manifest = await readJson(join(root, 'manifest.json'));
  const options = cappedOptions(
    storedIdleOptions(isRecord(manifest) ? manifest.profile : undefined),
    isProviderComponent(recorded) ? recorded : undefined,
  );
  diagnostics.push(...options.diagnostics);

  return {
    ...(isProviderComponent(recorded) && { provider: recorded }),
    options,
    diagnostics,
  };
}

/**
 * limits the idle options to the furthest ahead the provider can keep the
 * workstation awake, so a stored value beyond it (which validation refuses)
 * never produces a deadline the provider's adapter would reject
 * @param options the stored options
 * @param provider the recorded provider, when there is one
 * @returns the options as applied, noting each one the cap lowered
 */
function cappedOptions(
  options: IdleOptions,
  provider: ProviderComponent | undefined,
): IdleOptions {
  const cap = provider?.maxAwakeDeadlineMinutes ?? null;
  if (cap === null) {
    return options;
  }
  const diagnostics = [...options.diagnostics];
  const capped = (name: string, minutes: number): number => {
    if (minutes <= cap) {
      return minutes;
    }
    diagnostics.push(
      `${name} of ${minutes} minutes is capped at the ${cap} the provider can keep the workstation awake`,
    );

    return cap;
  };

  return {
    idleTimeoutMinutes: capped(
      'idleTimeoutMinutes',
      options.idleTimeoutMinutes,
    ),
    holdMaxMinutes: capped('holdMaxMinutes', options.holdMaxMinutes),
    diagnostics,
  };
}

/**
 * reads a host-written, root-owned JSON file
 * @param path absolute file path
 * @returns the decoded value, or undefined when it is missing or unreadable
 */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
