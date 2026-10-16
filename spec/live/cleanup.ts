import { setTimeout as delay } from 'node:timers/promises';

import { tail } from './cli';
import { isRunWorkstation } from './ownership';
import { isWorkstationDevice } from './tailnet';

import type { LiveCli } from './cli';
import type { LiveInventory, LiveProvider } from './providers';
import type { Redactor } from './redaction';
import type { Tailnet, TailnetDevice } from './tailnet';

/** guaranteed removal and absence proof for workstations of one live run */
export interface LiveCleanup {
  /**
   * terminates through the CLI, falls back to direct deletion, then proves absence
   * @param name exact workstation name inside the run prefix
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
  /** removes everything carrying the run prefix and proves nothing remains */
  sweep(): Promise<void>;
  /** refuses to start when the fresh run prefix is already in use */
  assertUnused(): Promise<void>;
}

/** collaborators and run identity for cleanup */
export interface LiveCleanupOptions {
  /** packed CLI driver used for the primary termination */
  cli: LiveCli;
  /** provider adapter used for inventory and fallback deletion */
  provider: LiveProvider;
  /** tailnet used for device absence proof and fallback deletion */
  tailnet: Tailnet;
  /** further provider accounts the run may hold workstations in, swept by direct deletion */
  inventories: readonly LiveInventory[];
  /** live run that owns every workstation this cleanup may touch */
  runId: string;
  /** removes dotenv values from every message cleanup writes or throws */
  redact: Redactor;
}

const TERMINATE_TIMEOUT_MS = 8 * 60_000;
const ABSENCE_TIMEOUT_MS = 3 * 60_000;
const ABSENCE_POLL_MS = 5_000;
const SWEEP_PASSES = 2;

/**
 * creates cleanup bound to one live run
 * @param options CLI, provider, tailnet, run identity and redaction
 * @returns run-scoped cleanup
 */
export function createLiveCleanup(options: LiveCleanupOptions): LiveCleanup {
  const { cli, provider, inventories, tailnet, runId, redact } = options;
  const prefix = `${runId}-`;
  const describe = (error: unknown): string =>
    redact(tail((error as Error).message));
  const report = (message: string): void => {
    process.stderr.write(`[live] ${redact(message)}\n`);
  };
  const devicesOf = async (name: string): Promise<TailnetDevice[]> =>
    (await tailnet.listDevices()).filter((device) =>
      isWorkstationDevice(device, name),
    );
  const runNames = async (): Promise<string[]> => {
    const [devices, ...listed] = await Promise.all([
      tailnet.listDevices(),
      provider.listWorkstations(prefix),
      ...inventories.map(async (inventory) =>
        inventory.listWorkstations(prefix),
      ),
    ]);
    const workstations = listed.flat();
    const deviceNames = devices
      .flatMap((device) => [device.hostname, device.shortName])
      .filter((name) => isRunWorkstation(name, runId));

    return [...new Set([...workstations, ...deviceNames])].sort();
  };
  const proveAbsent = async (name: string): Promise<void> => {
    const deadline = Date.now() + ABSENCE_TIMEOUT_MS;
    for (;;) {
      // a transient API failure is an unknown state, never proof either way
      const observation = await Promise.all([
        devicesOf(name),
        provider.hasWorkstation(name),
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
  const terminate = async (name: string): Promise<boolean> =>
    cli.json(['terminate', name, '--yes'], TERMINATE_TIMEOUT_MS).then(
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
  const remove = async (name: string): Promise<void> => {
    if (!isRunWorkstation(name, runId)) {
      throw new Error(`Refusing to clean up ${name} outside live run ${runId}`);
    }
    // deletion attempts may race another cleanup; the absence proof decides
    if (
      (await provider.hasWorkstation(name)) &&
      (!(await terminate(name)) || (await provider.hasWorkstation(name)))
    ) {
      report(`deleting ${name} directly through ${provider.name}`);
      await provider
        .deleteWorkstation(name, runId)
        .catch((error: unknown) =>
          report(`direct deletion of ${name} failed: ${describe(error)}`),
        );
    }
    for (const inventory of inventories) {
      if (await inventory.hasWorkstation(name)) {
        report(`deleting ${name} directly through ${inventory.name}`);
        await inventory
          .deleteWorkstation(name, runId)
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

  return {
    remove,
    proveAbsent,
    devicesOf,
    async sweep() {
      const failures: string[] = [];
      for (let pass = 0; pass < SWEEP_PASSES; pass++) {
        const names = await runNames();
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
      const remaining = await runNames();
      if (remaining.length > 0) {
        throw new Error(
          `Live run ${runId} left workstations behind: ${remaining.join(', ')}; ` +
            failures.join('; '),
        );
      }
    },
    async assertUnused() {
      const names = await runNames();
      if (names.length > 0) {
        throw new Error(
          `Live run prefix ${runId} is already in use by ${names.join(', ')}; choose a new run id`,
        );
      }
    },
  };
}
