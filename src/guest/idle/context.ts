import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_HOME, GUEST_ROOT, kernelModule } from '../guest-root.js';
import { resolveTrustedFile } from '../native-files.js';

import { applyAsAgentAccount } from './agent-apply.js';
import { APPLY_DEADLINE_LIMIT_MS } from './dispatch.js';
import { APPLY_LOCK, STATE_LOCK } from './lock.js';
import { readMachineClock } from './machine-clock.js';
import { AWAKE_DIRECTORY, MANAGED_AWAKE_DIRECTORY } from './state.js';

import type { TrustFile } from './adapter.js';
import type { MachineClock } from './machine-clock.js';
import type { AdapterResult } from './state.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. Every governor entry runs against one context, so tests and the
// packaged checks run the same code against a temporary guest root

/** the apply entry a root caller starts as the agent account, under the guest root */
const APPLY_ENTRY = kernelModule('idle/apply.js');

/** what the governor reads, writes and trusts */
export interface GovernorContext {
  /** absolute guest root holding the catalog, the manifest and the awake directories */
  root: string;
  /** user ids that may own a file in the shared awake directory: root and the agent account */
  owners: ReadonlySet<number>;
  /** user ids that may own a managed holder: root alone */
  managedOwners: ReadonlySet<number>;
  /**
   * whether the caller runs as root: root records its holds in the managed
   * awake directory, takes only the lock there, and never imports a
   * `native-deadline` adapter
   */
  asRoot: boolean;
  /** current epoch milliseconds */
  now: () => number;
  /** resolves the adapter module to a root-controlled file */
  trust: TrustFile;
  /**
   * applies the latest deadline as the agent account, for a root caller of a
   * `native-deadline` provider
   */
  applyAsAgent: () => Promise<AdapterResult>;
  /** where the process table is; `/proc` when absent */
  procRoot?: string;
  /**
   * reads the kernel's boot id and uptime, which let a tick tell a cold boot
   * and a snapshot resume from a long gap; absent where neither is detected
   */
  machineClock?: () => Promise<MachineClock | undefined>;
}

/**
 * builds the context the deployed command and managed operations run with:
 * the deployed guest root, root and the agent account as file owners, the
 * caller's own account, the root-controlled path check for the adapter, and
 * the agent-account child for a root caller's deadline
 * @param root directory the guest kernel was deployed under
 * @returns the context of the deployed governor
 */
export async function productionContext(
  root: string = GUEST_ROOT,
): Promise<GovernorContext> {
  const agent = await stat(AGENT_HOME).then(
    ({ uid, gid }) => ({ uid, gid }),
    () => undefined,
  );
  const uid = process.getuid?.();

  return {
    root,
    owners: new Set([
      0,
      ...(agent ? [agent.uid] : uid === undefined ? [] : [uid]),
    ]),
    managedOwners: new Set([0]),
    asRoot: uid === 0,
    now: Date.now,
    machineClock: async () => readMachineClock(),
    trust: resolveTrustedFile,
    applyAsAgent: async () =>
      applyAsAgentAccount({
        entry: join(root, APPLY_ENTRY),
        account: agent,
        limitMs: APPLY_DEADLINE_LIMIT_MS,
        at: new Date().toISOString(),
      }),
  };
}

/**
 * names the guest root a kernel module was deployed under, from the module's
 * own location in the guest root's `guest/idle` folder
 * @param moduleUrl `import.meta.url` of a module in this folder
 * @returns absolute guest root
 */
export function rootOfModule(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '../..');
}

/**
 * names the shared awake directory under the context's guest root
 * @param context guest root
 * @returns absolute shared awake directory
 */
export function awakeDirectory(context: Pick<GovernorContext, 'root'>): string {
  return join(context.root, AWAKE_DIRECTORY);
}

/**
 * names the managed awake directory under the context's guest root
 * @param context guest root
 * @returns absolute managed awake directory
 */
export function managedAwakeDirectory(
  context: Pick<GovernorContext, 'root'>,
): string {
  return join(context.root, MANAGED_AWAKE_DIRECTORY);
}

/**
 * names the awake directory the caller records its holds in and prunes: the
 * managed one for root, the shared one for the agent account
 * @param context guest root and the caller's account
 * @returns absolute awake directory the caller owns
 */
export function ownAwakeDirectory(
  context: Pick<GovernorContext, 'root' | 'asRoot'>,
): string {
  return context.asRoot
    ? managedAwakeDirectory(context)
    : awakeDirectory(context);
}

/**
 * names the state lock the caller takes: root's own in the managed awake
 * directory, the agent account's in the shared one
 * @param context guest root and the caller's account
 * @returns absolute lock file path
 */
export function stateLock(
  context: Pick<GovernorContext, 'root' | 'asRoot'>,
): string {
  return join(ownAwakeDirectory(context), STATE_LOCK);
}

/**
 * names the lock that serialises deadline applies, which only the agent
 * account takes
 * @param context guest root
 * @returns absolute lock file path
 */
export function applyLock(context: Pick<GovernorContext, 'root'>): string {
  return join(awakeDirectory(context), APPLY_LOCK);
}
