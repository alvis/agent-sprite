import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../records.js';

import { isOwnAwakeModule } from './provider-facts.js';

import type {
  AwakeDeadlineAdapter,
  IdleFormAdapter,
} from '../../drivers/awake-adapters.js';
import type { ProviderComponent } from '../../drivers/component-types.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The adapter is the one module the governor imports at run time, so
// it is named by the host-written catalog, must sit in the guest folder of the
// recorded provider under the fixed `-awake` suffix, and must resolve to a
// file every component of whose path only root controls

/**
 * resolves a module path to a root-controlled file, refusing anything else;
 * production passes `resolveTrustedFile`
 */
export type TrustFile = (path: string) => Promise<string>;

/** a loaded awake adapter of the shape the provider's keep-awake mode calls */
export type LoadedAwakeAdapter =
  | {
      /** keep-awake mode the adapter serves */
      mode: 'native-deadline';
      /** the provider's deadline adapter */
      adapter: AwakeDeadlineAdapter;
    }
  | {
      /** keep-awake mode the adapter serves */
      mode: 'governed';
      /** the provider's idle-form adapter */
      adapter: IdleFormAdapter;
    };

/** what the governor needs to load the recorded provider's adapter */
export interface AdapterSource {
  /** absolute guest root the module path is relative to */
  root: string;
  /** the provider as the host recorded it */
  provider: ProviderComponent;
  /** resolves the module to a root-controlled file */
  trust: TrustFile;
}

/**
 * loads the recorded provider's awake adapter for its keep-awake mode
 * @param source guest root, recorded provider and trust check
 * @returns the loaded adapter
 * @throws {Error} when a native-deadline adapter would load as root, the
 * provider declares no adapter, the module is outside
 * its own guest folder or lacks the `-awake` suffix, fails the trust check, or
 * does not export the function its keep-awake mode calls
 */
export async function loadAwakeAdapter(
  source: AdapterSource,
): Promise<LoadedAwakeAdapter> {
  const { root, provider, trust } = source;
  const { awakeAdapter, keepAwakeMode } = provider;
  if (keepAwakeMode === 'none') {
    throw new Error('a provider never kept awake has no awake adapter');
  }
  if (awakeAdapter === undefined) {
    throw new Error('the provider declares no awake adapter');
  }
  if (!isOwnAwakeModule(awakeAdapter, provider.id)) {
    throw new Error(
      `awake adapter ${awakeAdapter} is not an -awake module of the provider's own guest folder`,
    );
  }
  // the module's top level runs on import, so a root caller must never reach it
  if (keepAwakeMode === 'native-deadline' && process.getuid?.() === 0) {
    throw new Error('a native-deadline adapter never runs as root');
  }
  const module: unknown = await import(
    pathToFileURL(await trust(join(root, awakeAdapter))).href
  );
  if (keepAwakeMode === 'native-deadline' && isDeadlineAdapter(module)) {
    return { mode: keepAwakeMode, adapter: module };
  }
  if (keepAwakeMode === 'governed' && isIdleFormAdapter(module)) {
    return { mode: keepAwakeMode, adapter: module };
  }
  throw new Error(
    `awake adapter ${awakeAdapter} does not export what a ${keepAwakeMode} provider calls`,
  );
}

/**
 * tells whether a loaded module applies awake deadlines
 * @param module loaded adapter module
 * @returns true when the module exports `applyAwakeDeadline`
 */
function isDeadlineAdapter(module: unknown): module is AwakeDeadlineAdapter {
  return isRecord(module) && typeof module.applyAwakeDeadline === 'function';
}

/**
 * tells whether a loaded module enters idle forms
 * @param module loaded adapter module
 * @returns true when the module exports `enterIdleForm`
 */
function isIdleFormAdapter(module: unknown): module is IdleFormAdapter {
  return isRecord(module) && typeof module.enterIdleForm === 'function';
}
