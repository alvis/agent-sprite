import { networkDriver } from '#core/networks';
import { inspectHub } from '#drivers/shared/cliproxyapi/hub';
import { inspectNativeConfiguration } from '#integrations/native';
import { checkOperation, traceStage } from '#operation';

import { inspectGovernor } from './awake.js';
import { readGuestEnvironment, readUpdateStatus } from './environment-store.js';
import { settleInspectionResults } from './inspection-results.js';

import type { Interaction } from '#command/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestInspection } from './inspection-types.js';

const MILLISECONDS_PER_SECOND = 1000;
const INSPECTION_MESSAGES = {
  inspection:
    'Reading guest configuration; a sleeping workstation may need to wake',
  services: 'Checking managed services',
  network: 'Checking the selected network, DNS and exit routing',
  native: 'Checking harness configuration, plugins and the agent environment',
  proxy: 'Checking the selected model gateway catalogue',
  governor: 'Reading the idle governor state',
};

export type {
  GuestInspection,
  InspectionProbeFailure,
} from './inspection-types.js';

/**
 * fetches current service, route, and installation state on explicit inspection
 * @param guest target guest
 * @param progress optional observer for actual probe starts and elapsed completions
 * @returns current service, network, native, gateway, environment and update status
 */
export async function inspectGuest(
  guest: GuestChannel,
  progress?: Interaction['progress'],
): Promise<GuestInspection> {
  const [environment, updates] = await inspectStage(
    'inspection',
    async () =>
      Promise.all([readGuestEnvironment(guest), readUpdateStatus(guest)]),
    progress,
  );
  const { profile } = environment;
  const network = networkDriver(profile.network);
  // the governor report settles every failure into a reason itself
  const [[serviceProbe, networkProbe, nativeProbe, proxyProbe], governor] =
    await Promise.all([
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
    ]);

  return {
    ...settleInspectionResults({ environment, updates }, [
      serviceProbe,
      networkProbe,
      nativeProbe,
      proxyProbe,
    ]),
    governor,
  };
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
