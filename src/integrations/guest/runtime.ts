import { networkDriver } from '#core/networks';
import { inspectHub } from '#drivers/shared/cliproxyapi/hub';
import { inspectNativeConfiguration } from '#integrations/native/inspection';
import { checkOperation, traceStage } from '#operation';

import { inspectGovernor } from './awake';
import { readGuestEnvironment, readUpdateStatus } from './environment/store';
import { settleInspectionResults } from './inspection-results';

import type { Interaction } from '#command/contracts';
import type { BootReport, ProviderDriver } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestInspection } from './inspection-types';

const MILLISECONDS_PER_SECOND = 1000;
const INSPECTION_MESSAGES = {
  inspection:
    'Reading guest configuration; a sleeping workstation may need to wake',
  services: 'Checking managed services',
  network: 'Checking the selected network, DNS and exit routing',
  native: 'Checking harness configuration, plugins and the agent environment',
  proxy: 'Checking the selected model gateway catalogue',
  governor: 'Reading the idle governor state',
  boot: 'Reading the last boot record',
};

/** what an inspection reports to and reads besides the guest itself */
interface InspectionOptions {
  /** observer for actual probe starts and elapsed completions */
  progress?: Interaction['progress'];
  /** the provider, whose boot record is read when it keeps one */
  provider?: Pick<ProviderDriver, 'inspectBoot'>;
}

/**
 * fetches current service, route, and installation state on explicit inspection
 * @param guest target guest
 * @param options progress observer and the provider whose boot record is read
 * @returns current service, network, native, gateway, environment, update and boot status
 */
export async function inspectGuest(
  guest: GuestChannel,
  options: InspectionOptions = {},
): Promise<GuestInspection> {
  const { progress } = options;
  const [environment, updates] = await inspectStage(
    'inspection',
    async () =>
      Promise.all([readGuestEnvironment(guest), readUpdateStatus(guest)]),
    progress,
  );
  const { profile } = environment;
  const network = networkDriver(profile.network);
  // the governor report settles every failure into a reason itself
  const [
    [serviceProbe, networkProbe, nativeProbe, proxyProbe],
    governor,
    boot,
  ] = await Promise.all([
    Promise.allSettled([
      inspectStage('services', async () => guest.services.list(), progress),
      inspectStage('network', async () => network.status(guest), progress),
      inspectStage(
        'native',
        async () => inspectNativeConfiguration(guest, profile),
        progress,
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
        progress,
      ),
    ] as const),
    inspectStage('governor', async () => inspectGovernor(guest), progress),
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
}

/**
 * reads the provider's record of the last boot; the record is evidence only,
 * so a failure to read it is no probe failure
 * @param guest target guest
 * @param options progress observer and the provider whose boot record is read
 * @returns the boot record, nothing when the provider keeps none or it could not be read
 */
async function inspectBoot(
  guest: GuestChannel,
  options: InspectionOptions,
): Promise<BootReport | undefined> {
  const { progress, provider } = options;
  const read = provider?.inspectBoot?.bind(provider);
  if (!read) {
    return undefined;
  }
  try {
    return await inspectStage('boot', async () => read(guest), progress);
  } catch {
    checkOperation();

    return undefined;
  }
}

/**
 * reports a real probe's lifecycle without exposing commands or credentials
 * @param stage probe identity and non-secret description
 * @param check original probe operation
 * @param progress optional lifecycle observer
 * @returns the original probe result
 */
async function inspectStage<T>(
  stage: keyof typeof INSPECTION_MESSAGES,
  check: () => Promise<T>,
  progress?: Interaction['progress'],
): Promise<T> {
  const startedAt = performance.now();
  progress?.({ stage, message: INSPECTION_MESSAGES[stage] });
  try {
    const result = await traceStage(`inspect.${stage}`, check);
    progress?.({
      stage,
      message: `Completed (${((performance.now() - startedAt) / MILLISECONDS_PER_SECOND).toFixed(1)} s)`,
      completed: 1,
      total: 1,
    });

    return result;
  } catch (error) {
    checkOperation();
    progress?.({
      stage,
      message: `Check failed (${((performance.now() - startedAt) / MILLISECONDS_PER_SECOND).toFixed(1)} s)`,
    });
    throw error;
  }
}
