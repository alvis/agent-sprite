import { registry } from '#composition/registry';

import { createFlyInventory, flyMachineMetadata } from '../fly';

import { REQUEST_TIMEOUT_MS } from './limits';
import { guestOutput } from './output';

import type { MachineProvider, MachineProviderOptions } from '../providers';

type FlyDriver = ReturnType<
  (typeof registry.providers)['fly-machine']['authenticate']
>;

const RUNIT_PIDS =
  'cd /etc/service && for service in *; do printf "%s %s\\n" "$service" "$(cat "$service/supervise/pid" 2>/dev/null)"; done';
const FLY_METADATA_PREFIX = 'fly_';
const FLY_REQUIRED_LABELS = ['open-agent=managed', 'open-agent-schema=1'];

/**
 * adapts the Fly Machines API and the product's own Fly Machine driver, whose
 * guest channel reaches the machine as root, to the provider contract
 * @param options Fly organization token and redaction
 * @returns Fly Machine provider adapter
 */
export function createFlyProvider(
  options: MachineProviderOptions,
): MachineProvider {
  const { token, redact } = options;
  const inventory = createFlyInventory(token);
  const driver = registry.providers['fly-machine'].authenticate({
    credential: token,
    restorableServices: [],
  });
  const execute = async (name: string, script: string): Promise<string> => {
    const channel = await driver.openGuest(await driver.get(name));
    const result = await channel.exec({
      program: '/bin/sh',
      arguments: ['-c', script],
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    return guestOutput(result, redact);
  };

  return {
    ...inventory,
    name: 'fly-machine',
    execute,
    /**
     * reads Fly Machine metadata and guest state paths
     * @param name exact workstation name
     * @returns provider identity and guest state paths
     */
    async inspectIdentity(name) {
      const metadata = await flyMachineMetadata(token, name);
      const listing = await execute(
        name,
        'find /opt /etc/cron.d /home/agent/.config /var/lock -mindepth 1 -maxdepth 1',
      );

      return {
        // Fly's own keys are the platform's, not identifiers of a product
        labels: Object.entries(metadata)
          .filter(([key]) => !key.startsWith(FLY_METADATA_PREFIX))
          .map(([key, value]) => `${key}=${value}`),
        requiredLabels: FLY_REQUIRED_LABELS,
        guestPaths: listing.split('\n').filter(Boolean),
        schedule: await execute(name, 'cat /etc/cron.d/open-agent'),
      };
    },
    snapshotServices: createFlyServiceReader(driver, execute),
    /**
     * reads the Fly Machine's current state without transition times
     * @param name exact workstation name
     * @returns provider status with no transition timestamps
     */
    async readRunState(name) {
      const { state } = await driver.get(name);

      // the Machines API reports the state alone, without transition times
      return {
        status: state,
        lastRunningAt: undefined,
        lastWarmingAt: undefined,
      };
    },
    // a Fly Machine keeps no awake task: the idle governor alone decides
    readAwakeTask: async () => undefined,
    /**
     * reads the Fly Machine's public URL
     * @param name exact workstation name
     * @returns public URL
     */
    async readUrl(name) {
      const { url } = await driver.get(name);
      if (!url) {
        throw new Error(`${name} has no public URL`);
      }

      return url;
    },
  };
}

/**
 * reads supervised Fly services and their runit process identities
 * @param driver authenticated Fly driver
 * @param execute redacted guest shell execution
 * @returns the service snapshot operation
 */
function createFlyServiceReader(
  driver: FlyDriver,
  execute: MachineProvider['execute'],
): MachineProvider['snapshotServices'] {
  return async (name: string) => {
    const channel = await driver.openGuest(await driver.get(name));
    const services = await channel.services.list();
    // the service state carries no process id; runsv records it beside each service
    const pids = new Map(
      (await execute(name, RUNIT_PIDS))
        .split('\n')
        .map((line) => line.split(' '))
        .flatMap(([service, pid]) =>
          service && pid ? [[service, Number(pid)] as const] : [],
        ),
    );

    return services
      .map((service) => ({
        name: service.name,
        status: service.status ?? 'unknown',
        needs: [...service.needs],
        pid: pids.get(service.name),
        startedAt: service.startedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
}
