import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { isSupervisedProvider } from '#core/services';
import { inspectHub } from '#drivers/shared/cliproxyapi/hub';
import { isComponentOutcomes, OUTCOMES_PATH } from '#guest/component-outcome';
import {
  GUEST_KERNEL,
  GUEST_NODE,
  GUEST_ROOT,
  kernelModule,
} from '#guest/guest-root';
import { inspectNativeConfiguration } from '#integrations/native';
import { checkOperation, traceStage } from '#operation';

import { guestFileExists, readGuestFile, runGuest } from '../guest.js';

import { writeComponentCatalog } from './component-catalog.js';
import { inspectGovernor, installAwakeCommand } from './governor.js';
import { writeHarnessCatalog } from './harness-catalog.js';
import { settleInspectionResults } from './inspection-results.js';
import { runGuestInstaller } from './installer-diagnostics.js';
import { readGuestManifest, writeGuestManifest } from './manifest.js';
import { deployGuestPayload } from './payloads.js';
import { installSupervisor, installUpdateSchedule } from './services.js';
import { withGuestTransaction } from './transaction.js';
import { readInstalledVersions } from './versions.js';

import type { Interaction } from '#command/contracts';
import type { AgentId, HarnessId, NetworkId, ProviderId } from '#core/catalog';
import type { WorkstationProfile } from '#core/profile';
import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestInspection } from './inspection-types.js';
import type { GuestManifest } from './types.js';

export { readGuestManifest, writeGuestProfile } from './manifest.js';
export type { GuestManifest, GuestNetworkIdentity } from './manifest.js';
export { installManagedServices } from './services.js';

const MANIFEST_PATH = `${GUEST_ROOT}/manifest.json`;
const INSTALL_TIMEOUT_MS = 1_200_000;
const UPDATE_TIMEOUT_MS = 1_500_000;
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
 * installs the latest stable managed tools into the persistent guest filesystem
 * @param guest target guest
 * @param profile validated selection recorded for a new installation
 * @returns what the run did to each component, when it recorded any
 */
export async function installGuestTools(
  guest: GuestChannel,
  profile: WorkstationProfile,
): Promise<GuestManifest['componentOutcomes']> {
  // the transaction installs Node when it is missing, before the installer's
  // own Node gate runs and finds it current
  const isNodeMissing = !(await guestFileExists(guest, GUEST_NODE));

  return withGuestTransaction(
    guest,
    async () => {
      await ensureGuestDirectories(guest);
      const isExisting = await guestFileExists(guest, MANIFEST_PATH);
      const stored = isExisting
        ? (await readGuestManifest(guest)).profile
        : undefined;
      const { provider, agent, harnesses, network, options } =
        stored ?? profile;
      await deployInstallerPayload(guest, {
        provider,
        agent,
        harnesses,
        network,
        options,
      });
      if (stored) {
        // the refreshed kernel brings its update entry with it
        await installUpdateSchedule(guest);
        await updateGuestTools(guest);

        return readComponentOutcomes(guest);
      }
      await runGuestInstaller(guest, {
        script: 'install-tools.js',
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      const now = new Date().toISOString();
      const componentOutcomes = nodeInstalledHere(
        await readComponentOutcomes(guest),
        isNodeMissing,
      );
      const manifest: GuestManifest = {
        schema: 1,
        createdAt: now,
        lastSuccessfulUpdate: now,
        lastUpdateStatus: 'succeeded',
        installedVersions: await readInstalledVersions(guest, {
          agent,
          harnesses,
          network,
        }),
        ...(componentOutcomes && { componentOutcomes }),
        profile,
      };
      await writeGuestManifest(guest, manifest);

      return componentOutcomes;
    },
    true,
  );
}

/**
 * creates the root-owned guest root and lock directories the installer needs
 * @param guest target guest
 */
async function ensureGuestDirectories(guest: GuestChannel): Promise<void> {
  await runGuest(guest, [
    '/usr/bin/install',
    '-d',
    '-o',
    'root',
    '-g',
    'root',
    '-m',
    '0755',
    GUEST_ROOT,
    '/run/lock',
  ]);
}

/**
 * reports a private Node that the transaction itself installed as installed,
 * not as the current Node the installer's gate found right after
 * @param outcomes what the installer recorded
 * @param isNodeMissing whether the guest had no private Node before the transaction
 * @returns the outcomes with the private Node's status corrected when needed
 */
function nodeInstalledHere(
  outcomes: GuestManifest['componentOutcomes'],
  isNodeMissing: boolean,
): GuestManifest['componentOutcomes'] {
  const node = outcomes?.['guest-node'];
  if (!outcomes || !isNodeMissing || node?.status !== 'skipped') {
    return outcomes;
  }

  return { ...outcomes, 'guest-node': { ...node, status: 'installed' } };
}

/**
 * reads what the install run just finished did to each component
 * @param guest target guest
 * @returns the recorded outcomes, or nothing when the run left none
 */
async function readComponentOutcomes(
  guest: GuestChannel,
): Promise<GuestManifest['componentOutcomes']> {
  if (!(await guestFileExists(guest, OUTCOMES_PATH))) {
    return undefined;
  }
  const outcomes: unknown = JSON.parse(
    await readGuestFile(guest, OUTCOMES_PATH),
  );

  return isComponentOutcomes(outcomes) ? outcomes : undefined;
}

/**
 * executes the updater under its caller's continuously held filesystem lock
 * @param guest target guest
 */
async function updateGuestTools(guest: GuestChannel): Promise<void> {
  // the transaction holding the lock has just staged every updater module
  await runGuest(guest, [GUEST_NODE, `${GUEST_KERNEL}/updater.js`, '--force'], {
    timeoutMs: UPDATE_TIMEOUT_MS,
    step: 'updater.js',
  });
}

/**
 * stages root installer and agent-readable hook helpers before tool installation
 * @param guest target guest
 * @param selection selected provider, agent, harness and network identifiers, and the options that decide how the agent is installed
 * @param selection.provider selected provider
 * @param selection.agent selected ACP agent
 * @param selection.harnesses selected harnesses
 * @param selection.network selected network, whose tool the installer installs
 * @param selection.options profile options, whose release channel selects the agent's dist-tag
 */
async function deployInstallerPayload(
  guest: GuestChannel,
  selection: {
    provider: ProviderId;
    agent: AgentId;
    harnesses: readonly HarnessId[];
    network: NetworkId;
    options: WorkstationProfile['options'];
  },
): Promise<void> {
  const harnesses = harnessDrivers(selection.harnesses);
  await writeHarnessCatalog(guest, harnesses);
  await writeComponentCatalog(guest, selection);
  await installAwakeCommand(guest);
  if (isSupervisedProvider(selection.provider)) {
    await installSupervisor(guest);
  }
  for (const module of [
    'harness-catalog.js',
    'component-catalog.js',
    'install-tools.js',
    'update-schedule.js',
  ]) {
    await deployGuestPayload(guest, kernelModule(module));
  }
  for (const filename of [
    ...harnesses.flatMap(({ guest: payloads }) =>
      payloads
        .filter(({ account }) => account === 'agent')
        .map(({ module }) => module),
    ),
    kernelModule('native-files.js'),
  ]) {
    await deployGuestPayload(guest, filename);
  }
}

/**
 * fetches current service, route, and installation state on explicit inspection
 * @param guest target guest
 * @param progress optional observer for actual probe starts and elapsed completions
 * @returns current service, network, native, gateway, and manifest status
 */
export async function inspectGuest(
  guest: GuestChannel,
  progress?: Interaction['progress'],
): Promise<GuestInspection> {
  const manifest = await inspectStage(
    'inspection',
    async () => readGuestManifest(guest),
    progress,
  );
  const network = networkDriver(manifest.profile.network);
  // the governor report settles every failure into a reason itself
  const [[serviceProbe, networkProbe, nativeProbe, proxyProbe], governor] =
    await Promise.all([
      Promise.allSettled([
        inspectStage('services', async () => guest.services.list(), progress),
        inspectStage('network', async () => network.status(guest), progress),
        inspectStage(
          'native',
          async () => inspectNativeConfiguration(guest, manifest.profile),
          progress,
        ),
        inspectStage(
          'proxy',
          async () =>
            manifest.profile.options.isProxyEnabled
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
    ...settleInspectionResults(manifest, [
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
