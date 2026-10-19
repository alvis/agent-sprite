import { inspectGovernor } from '#adapters/guest/governor';
import { inspectHub } from '#adapters/guest/hub';
import { checkOperation, traceStage } from '#kernel/operation';

import { settleInspectionResults } from './results';

import type { NativeInspection } from '#adapters/guest/native/inspection';
import type { DriverRegistry } from '#application/ports/drivers';
import type {
  GuestEnvironmentAccess,
  GuestMechanics,
  InspectionParams,
  InspectionProbe,
  ProbeEvent,
} from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { BootReport } from '#domain/observations/boot';

/**
 * builds the guest inspection over the registered drivers
 * @param context what the probes read
 * @param context.registry every registered driver
 * @param context.environment the recorded environment's reads
 * @param context.native the native configuration's reads
 * @returns the probes an inspection runs, settled into one report
 */
export function createInspection(context: {
  registry: DriverRegistry;
  environment: GuestEnvironmentAccess;
  native: NativeInspection;
}): GuestMechanics['inspection'] {
  const { registry, environment: access, native } = context;

  return {
    /**
     * fetches current service, route, and installation state on explicit inspection
     * @param guest target guest
     * @param options probe observer and the provider whose boot record is read
     * @returns current service, network, native, gateway, environment, update and boot status
     */
    inspect: async (guest, options = {}) => {
      const { onProbe } = options;
      const [environment, updates] = await inspectStage(
        'inspection',
        async () =>
          Promise.all([access.read(guest), access.readUpdateStatus(guest)]),
        onProbe,
      );
      const { profile } = environment;
      const network = registry.networks[profile.network];
      // the governor report settles every failure into a reason itself
      const [
        [serviceProbe, networkProbe, nativeProbe, proxyProbe],
        governor,
        boot,
      ] = await Promise.all([
        Promise.allSettled([
          inspectStage('services', async () => guest.services.list(), onProbe),
          inspectStage('network', async () => network.status(guest), onProbe),
          inspectStage(
            'native',
            async () => native.inspect(guest, profile),
            onProbe,
          ),
          inspectStage(
            'proxy',
            async () =>
              profile.options.isProxyEnabled
                ? inspectHub(guest)
                : Promise.resolve({
                    reachable: false,
                    skipped: true,
                    reason: 'The model gateway is disabled',
                  }),
            onProbe,
          ),
        ] as const),
        inspectStage('governor', async () => inspectGovernor(guest), onProbe),
        inspectBoot(guest, options),
      ]);

      return {
        ...settleInspectionResults({ environment, updates }, [
          serviceProbe,
          networkProbe,
          nativeProbe,
          proxyProbe,
        ]),
        governor,
        ...(boot ? { boot } : {}),
      };
    },
  };
}

/**
 * reads the provider's record of the last boot; the record is evidence only,
 * so a failure to read it is no probe failure
 * @param guest target guest
 * @param options probe observer and the provider whose boot record is read
 * @returns the boot record, nothing when the provider keeps none or it could not be read
 */
async function inspectBoot(
  guest: GuestChannel,
  options: InspectionParams,
): Promise<BootReport | undefined> {
  const { onProbe, provider } = options;
  const read = provider?.inspectBoot?.bind(provider);
  if (!read) {
    return undefined;
  }
  try {
    return await inspectStage('boot', async () => read(guest), onProbe);
  } catch {
    checkOperation();

    return undefined;
  }
}

/**
 * reports a real probe's lifecycle without exposing commands or credentials
 * @param probe probe identity
 * @param check original probe operation
 * @param onProbe optional lifecycle observer
 * @returns the original probe result
 */
async function inspectStage<T>(
  probe: InspectionProbe,
  check: () => Promise<T>,
  onProbe?: (event: ProbeEvent) => void,
): Promise<T> {
  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;
  onProbe?.({ probe, phase: 'started' });
  try {
    const result = await traceStage(`inspect.${probe}`, check);
    onProbe?.({ probe, phase: 'completed', durationMs: elapsed() });

    return result;
  } catch (error) {
    checkOperation();
    onProbe?.({ probe, phase: 'failed', durationMs: elapsed() });
    throw error;
  }
}
