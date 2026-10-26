import { setTimeout as delay } from 'node:timers/promises';

import { tail } from '../cli';
import { isScopedWorkstation } from '../ownership';
import { isWorkstationDevice } from '../tailnet';

import type { MachineCleanup, MachineCleanupOptions } from '../cleanup';
import type { MachineInventory } from '../providers';
import type { TailnetDevice } from '../tailnet';

/** collaborators of the CLI-first cleanup operation */
interface CleanupRemoverParams {
  /** CLI, provider inventories, tailnet and scope */
  options: MachineCleanupOptions;
  /** lists devices and verifies final absence */
  queries: Pick<CleanupQueries, 'devicesOf' | 'proveAbsent'>;
  /** reports redacted cleanup failures */
  messages: CleanupMessages;
}

/** reads scoped resources and proves their absence through both services */
interface CleanupQueries {
  devicesOf: (name: string) => Promise<TailnetDevice[]>;
  scopedNames: () => Promise<string[]>;
  proveAbsent: (name: string) => Promise<void>;
}

/** redacted cleanup diagnostics */
interface CleanupMessages {
  report: (message: string) => void;
  describe: (error: unknown) => string;
}

const TERMINATE_TIMEOUT_MS = 480_000;
const ABSENCE_TIMEOUT_MS = 180_000;
const ABSENCE_POLL_MS = 5_000;
const SWEEP_PASSES = 2;

/**
 * creates cleanup bound to one scope
 * @param options CLI, provider inventories, tailnet, scope and redaction
 * @returns scoped cleanup
 * @throws {Error} for a malformed scope, which could reach foreign workstations
 */
export function createMachineCleanup(
  options: MachineCleanupOptions,
): MachineCleanup {
  const { scope, redact } = options;
  if (!isScopedWorkstation(scope, scope)) {
    throw new Error(
      `Refusing a cleanup scope outside the e2e prefix: ${scope}`,
    );
  }
  const describe = (error: unknown): string =>
    redact(tail((error as Error).message));
  const report = (message: string): void => {
    process.stderr.write(`[e2e] ${redact(message)}\n`);
  };
  const { devicesOf, scopedNames, proveAbsent } = createCleanupQueries(
    options,
    describe,
  );
  const remove = createCleanupRemover({
    options,
    queries: { devicesOf, proveAbsent },
    messages: { report, describe },
  });

  return {
    remove,
    proveAbsent,
    devicesOf,
    /**
     * removes every workstation remaining in this cleanup scope
     * @returns when the sweep completes or reports remaining machines
     */
    async sweep() {
      const failures: string[] = [];
      for (let pass = 0; pass < SWEEP_PASSES; pass++) {
        const names = await scopedNames();
        if (names.length === 0) {
          return;
        }
        const results = await Promise.allSettled(names.map(remove));
        failures.push(
          ...results.flatMap((result) =>
            result.status === 'rejected' ? [describe(result.reason)] : [],
          ),
        );
      }
      const remaining = await scopedNames();
      if (remaining.length > 0) {
        throw new Error(
          `Cleanup of ${scope}* left workstations behind: ${remaining.join(', ')}; ` +
            failures.join('; '),
        );
      }
    },
  };
}

/**
 * creates the listing and absence checks shared by removal and sweep
 * @param options provider inventories, tailnet and scope
 * @param describe redacts an API failure
 * @returns scoped resource queries
 */
function createCleanupQueries(
  options: MachineCleanupOptions,
  describe: (error: unknown) => string,
): CleanupQueries {
  const { inventories, tailnet, scope } = options;
  const devicesOf = async (name: string): Promise<TailnetDevice[]> =>
    (await tailnet.listDevices()).filter((device) =>
      isWorkstationDevice(device, name),
    );
  const scopedNames = async (): Promise<string[]> => {
    const [devices, ...listed] = await Promise.all([
      tailnet.listDevices(),
      ...inventories.map(async (inventory) =>
        inventory.listWorkstations(scope),
      ),
    ]);
    const workstations = listed.flat();
    const deviceNames = devices
      .flatMap((device) => [device.hostname, device.shortName])
      .filter((name) => isScopedWorkstation(name, scope));

    return [...new Set([...workstations, ...deviceNames])].sort();
  };
  const proveAbsent = async (name: string): Promise<void> => {
    const deadline = Date.now() + ABSENCE_TIMEOUT_MS;
    for (;;) {
      // a transient API failure is an unknown state, never proof either way
      const observation = await Promise.all([
        devicesOf(name),
        ...inventories.map(async (inventory) => inventory.hasWorkstation(name)),
      ]).then(
        ([devices, ...presence]) => ({
          present: presence.some(Boolean),
          devices: devices.length,
        }),
        (error: unknown) => ({ error: describe(error) }),
      );
      if (
        'present' in observation &&
        !observation.present &&
        observation.devices === 0
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'present' in observation
            ? `${name} remains after cleanup: provider ${observation.present ? 'present' : 'absent'}, ` +
                `${observation.devices} tailnet device(s)`
            : `${name} absence could not be confirmed: ${observation.error}`,
        );
      }
      await delay(ABSENCE_POLL_MS);
    }
  };

  return { devicesOf, scopedNames, proveAbsent };
}

/**
 * creates the CLI-first deletion with direct provider and tailnet fallback
 * @param params cleanup options, absence queries and redacted diagnostics
 * @returns scoped removal operation
 */
function createCleanupRemover(
  params: CleanupRemoverParams,
): MachineCleanup['remove'] {
  const { options, queries, messages } = params;
  const { cli, inventories, tailnet, scope } = options;
  const { devicesOf, proveAbsent } = queries;
  const { report, describe } = messages;
  const terminate = async (
    name: string,
    inventory: MachineInventory,
  ): Promise<boolean> =>
    cli
      .json(
        ['terminate', name, '--provider', inventory.name, '--yes'],
        TERMINATE_TIMEOUT_MS,
      )
      .then(
        (outcome) => {
          if (!outcome.envelope.ok) {
            report(
              `terminate ${name} failed: ${JSON.stringify(outcome.envelope.error)}`,
            );
          }

          return outcome.envelope.ok;
        },
        (error: unknown) => {
          report(`terminate ${name} failed: ${describe(error)}`);

          return false;
        },
      );

  return async (name: string): Promise<void> => {
    if (!isScopedWorkstation(name, scope)) {
      throw new Error(`Refusing to clean up ${name} outside ${scope}*`);
    }
    // deletion attempts may race another cleanup; the absence proof decides
    for (const inventory of inventories) {
      if (
        (await inventory.hasWorkstation(name)) &&
        (!(await terminate(name, inventory)) ||
          (await inventory.hasWorkstation(name)))
      ) {
        report(`deleting ${name} directly through ${inventory.name}`);
        await inventory
          .deleteWorkstation(name, scope)
          .catch((error: unknown) =>
            report(`direct deletion of ${name} failed: ${describe(error)}`),
          );
      }
    }
    for (const device of await devicesOf(name)) {
      report(`deleting leftover tailnet device ${name}`);
      await tailnet
        .deleteDevice(device.id)
        .catch((error: unknown) =>
          report(`tailnet deletion of ${name} failed: ${describe(error)}`),
        );
    }
    await proveAbsent(name);
  };
}
