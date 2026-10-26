import { setTimeout as delay } from 'node:timers/promises';

import { PROVIDER_IDS } from '#domain/ids';

import { tail } from './cli';
import { TEST_PREFIX } from './identity';
import { isScopedWorkstation } from './ownership';
import { createMachineProvider, credentialVariable } from './providers';
import { createRedactor } from './redaction';
import { connectTailnet, isWorkstationDevice } from './tailnet';
import { SECOND_MS } from './timing';

import type { MachineCli } from './cli';
import type { MachineInventory } from './providers';
import type { Redactor } from './redaction';
import type { Tailnet, TailnetDevice } from './tailnet';

export { createMachineCleanup } from './cleanup/scoped';

/** guaranteed removal and absence proof for the workstations of one cleanup scope */
export interface MachineCleanup {
  /**
   * terminates through the CLI, falls back to direct deletion, then proves absence
   * @param name exact workstation name inside the scope
   */
  remove(name: string): Promise<void>;
  /**
   * waits until neither the provider nor the tailnet reports the workstation
   * @param name exact workstation name
   */
  proveAbsent(name: string): Promise<void>;
  /**
   * lists tailnet devices carrying the workstation name
   * @param name exact workstation name
   * @returns matching devices
   */
  devicesOf(name: string): Promise<TailnetDevice[]>;
  /** removes everything inside the scope and proves nothing remains */
  sweep(): Promise<void>;
}

/** collaborators and scope of a cleanup */
export interface MachineCleanupOptions {
  /** packed CLI driver used for the primary termination */
  cli: MachineCli;
  /** provider accounts the scope may hold workstations in, for inventory and fallback deletion */
  inventories: readonly MachineInventory[];
  /** tailnet used for device absence proof and fallback deletion */
  tailnet: Tailnet;
  /** the name prefix of every workstation this cleanup may touch: `oa-e2e-`, or one run's `<run id>-` */
  scope: string;
  /** removes credential values from every message cleanup writes or throws */
  redact: Redactor;
}

/** inputs used to gather one run's cleanup targets */
interface BestEffortTargetsParams {
  /** provider accounts and tailnet searched during cleanup */
  accounts: RunAccounts;
  /** run-specific workstation prefix */
  scope: string;
  /** bounds each listing request */
  within: <T>(work: () => Promise<T>, fallback: T) => Promise<T>;
}

/** the provider accounts and tailnet a run's cleanup reaches */
export interface RunAccounts {
  /** an inventory for every machine type whose `TEST_*` token is set */
  inventories: readonly MachineInventory[];
  /** the tailnet holding the workstations' devices */
  tailnet: Tailnet;
}

/** what a best-effort cleanup removes, and how long it may take */
export interface BestEffortCleanup {
  /** the run's `<run id>-` scope */
  scope: string;
  /** milliseconds every request together may take */
  limitMs: number;
  /** the signal that interrupted the run, announced with the names; absent at teardown */
  signal?: string;
  /** removes credential values from what the cleanup prints */
  redact: Redactor;
}

/** how often a best-effort cleanup looks again for what it deleted */
const CONFIRM_POLL_MS = 1_000;
/** what to do about a workstation a best-effort cleanup could not confirm gone */
export const MANUAL_CHECK =
  'check them with `pnpm run -s local -- list` and the tailnet admin console, ' +
  'or rerun `pnpm test:e2e cli` with the same TEST_* credentials: its start sweep removes every oa-e2e-* workstation';

/**
 * connects every provider account the run has a `TEST_*` token for, and the tailnet
 * @param redact removes credential values from guest output
 * @returns the accounts, or undefined when no provider token is set and
 * nothing can have been created
 */
export function connectRunAccounts(redact: Redactor): RunAccounts | undefined {
  const inventories = PROVIDER_IDS.flatMap((type) => {
    const token = process.env[credentialVariable(type)]?.trim() ?? '';

    return token === '' ? [] : [createMachineProvider(type, { token, redact })];
  });

  return inventories.length > 0
    ? {
        inventories,
        tailnet: connectTailnet({
          apiKey: requireValue('TAILSCALE_API_KEY'),
          tailnet: requireValue('TAILSCALE_TAILNET'),
        }),
      }
    : undefined;
}

/**
 * lists the run's workstations and tailnet devices, sends every deletion at
 * once, then looks for them until the time limit; nothing waits past the
 * limit, nothing is retried and nothing fails the run. It prints
 * `cleanup successful`, or which workstations need a manual check and how
 * @param accounts the provider accounts and tailnet
 * @param cleanup the run's scope, time limit, signal and redaction
 */
export async function cleanUpBestEffort(
  accounts: RunAccounts,
  cleanup: BestEffortCleanup,
): Promise<void> {
  const { inventories, tailnet } = accounts;
  const { scope, limitMs, signal, redact } = cleanup;
  const deadline = Date.now() + limitMs;
  const report = (message: string): void => {
    process.stderr.write(`[e2e] ${redact(message)}\n`);
  };
  // a request that fails or outlives the limit counts as unanswered
  const within = async <T>(work: () => Promise<T>, fallback: T): Promise<T> =>
    beforeDeadline(work, deadline).catch((error: unknown) => {
      report(tail((error as Error).message));

      return fallback;
    });

  const { devices, names } = await bestEffortTargets({
    accounts,
    scope,
    within,
  });
  if (signal) {
    report(
      names.length > 0
        ? `${signal} received; trying to terminate ${names.join(', ')}`
        : `${signal} received; no workstation to terminate`,
    );
  }

  await Promise.all(
    names.flatMap((name) => [
      ...inventories.map(async (inventory) =>
        within(async () => {
          if (await inventory.hasWorkstation(name)) {
            await inventory.deleteWorkstation(name, scope);
          }
        }, undefined),
      ),
      ...(devices ?? [])
        .filter((device) => isWorkstationDevice(device, name))
        .map(async (device) =>
          within(async () => tailnet.deleteDevice(device.id), undefined),
        ),
    ]),
  );

  let remaining = names;
  while (remaining.length > 0 && Date.now() < deadline) {
    remaining = await stillPresent(accounts, remaining, within);
    if (remaining.length > 0) {
      await delay(Math.min(CONFIRM_POLL_MS, deadline - Date.now()));
    }
  }
  if (devices === undefined) {
    // the listing never answered, so the run's devices are unknown
    report(`the tailnet did not list this run's devices; ${MANUAL_CHECK}`);
  } else if (remaining.length === 0) {
    report('cleanup successful');
  } else {
    report(
      `could not confirm within ${limitMs / SECOND_MS}s that ${remaining.join(', ')} ${remaining.length === 1 ? 'is' : 'are'} gone; ${MANUAL_CHECK}`,
    );
  }
}

/**
 * gathers provider names and tailnet devices that fall within the run scope
 * @param params run accounts, workstation scope and bounded listing requests
 * @returns devices and sorted workstation names to remove
 */
async function bestEffortTargets(
  params: BestEffortTargetsParams,
): Promise<{ devices: TailnetDevice[] | undefined; names: string[] }> {
  const { accounts, scope, within } = params;
  const [devices, ...listed] = await Promise.all([
    within<TailnetDevice[] | undefined>(
      async () => accounts.tailnet.listDevices(),
      undefined,
    ),
    ...accounts.inventories.map(async (inventory) =>
      within(async () => inventory.listWorkstations(scope), []),
    ),
  ]);
  const names = [
    ...new Set([
      ...listed.flat(),
      ...(devices ?? []).flatMap((device) => [
        device.hostname,
        device.shortName,
      ]),
    ]),
  ]
    .filter((name) => isScopedWorkstation(name, scope))
    .sort();

  return { devices, names };
}

/**
 * the best-effort cleanup an interruption runs in a child process, since the
 * interrupted process may only block; it never throws
 * @param input JSON of the scope, time limit and signal
 */
export async function cleanUpInterruptedRun(input: string): Promise<void> {
  const redact = createRedactor(process.env);
  const { scope, limitMs, signal } = JSON.parse(input) as Omit<
    BestEffortCleanup,
    'redact'
  >;
  try {
    const accounts = connectRunAccounts(redact);
    if (accounts) {
      await cleanUpBestEffort(accounts, { scope, limitMs, signal, redact });
    }
  } catch (error) {
    process.stderr.write(
      `[e2e] ${redact(tail((error as Error).message))}; ${MANUAL_CHECK}\n`,
    );
  }
}

/**
 * tells which workstations a provider or the tailnet may still hold
 * @param accounts the provider accounts and tailnet
 * @param names workstations deleted
 * @param within bounds each request by the cleanup's deadline
 * @returns the names not proven gone
 */
async function stillPresent(
  accounts: RunAccounts,
  names: readonly string[],
  within: <T>(work: () => Promise<T>, fallback: T) => Promise<T>,
): Promise<string[]> {
  const { inventories, tailnet } = accounts;
  const [devices, ...presence] = await Promise.all([
    within<TailnetDevice[] | undefined>(
      async () => tailnet.listDevices(),
      undefined,
    ),
    ...names.map(async (name) =>
      within(
        async () =>
          (
            await Promise.all(
              inventories.map(async (inventory) =>
                inventory.hasWorkstation(name),
              ),
            )
          ).some(Boolean),
        true,
      ),
    ),
  ]);

  // an unanswered request is no proof of absence
  return names.filter(
    (name, index) =>
      presence[index] !== false ||
      devices === undefined ||
      devices.some((device) => isWorkstationDevice(device, name)),
  );
}

/**
 * settles a request or rejects once the deadline passes, so no request holds
 * a cleanup past its limit
 * @param work the request
 * @param deadline epoch milliseconds
 * @returns what the request resolves to
 */
async function beforeDeadline<T>(
  work: () => Promise<T>,
  deadline: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('a cleanup request outlived its time limit')),
      Math.max(0, deadline - Date.now()),
    );
  });

  try {
    return await Promise.race([work(), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * reads a `TEST_*` value cleanup cannot do without
 * @param name variable name without its `TEST_` prefix
 * @returns trimmed value
 * @throws {Error} naming the variable, never a value, when it is unset
 */
function requireValue(name: string): string {
  const value = process.env[`${TEST_PREFIX}${name}`]?.trim();
  if (!value) {
    throw new Error(
      `${TEST_PREFIX}${name} is required whenever a provider token is set, to sweep and prove tailnet devices absent`,
    );
  }

  return value;
}
