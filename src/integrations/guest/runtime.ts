import { inspectNativeConfiguration } from '#integrations/native';
import { checkOperation, runBoundedIO, traceStage } from '#operation';
import { isRecord } from '#utilities/guards';

import { listGuestServices, guestFileExists, runGuest } from '../guest.js';

import { settleInspectionResults } from './inspection-results.js';
import { runGuestInstaller } from './installer-diagnostics.js';
import {
  guestIntegrations,
  readGuestManifest,
  writeGuestManifest,
} from './manifest.js';
import { PAYLOAD_DIRECTORY, deployGuestPayload } from './payloads.js';
import { inspectTailscale } from './tailscale.js';
import { withGuestTransaction } from './transaction.js';
import { readInstalledVersions } from './versions.js';

import type { Sprite } from '@fly/sprites';

import type { Interaction } from '#command/contracts';

import type { GuestInspection, HubStatus } from './inspection-types.js';
import type { GuestIntegrations, GuestManifest } from './types.js';

export {
  configureTailscale,
  disableTailscale,
  inspectTailscale,
} from './tailscale.js';
export type { TailnetStatus } from './tailscale.js';
export { readGuestManifest, writeGuestIntegrations } from './manifest.js';
export type {
  GuestIntegrations,
  GuestManifest,
  GuestTailnetIdentity,
} from './manifest.js';
export { installManagedServices } from './services.js';

const MANIFEST_PATH = `${PAYLOAD_DIRECTORY}/manifest.json`;
const SCRIPT_MODE = 0o700;
const AGENT_SCRIPT_MODE = 0o755;
const INSTALL_TIMEOUT_MS = 1_200_000;
const UPDATE_TIMEOUT_MS = 1_500_000;
const MILLISECONDS_PER_SECOND = 1000;
const INSPECTION_MESSAGES = {
  inspection: 'Reading guest configuration; a sleeping Sprite may need to wake',
  services: 'Checking managed services',
  tailscale: 'Checking selected Tailscale, DNS and exit routing',
  native:
    'Checking Claude/Codex configuration, plugins and fresh T3 provider discovery',
  proxy: 'Checking selected CLIProxyAPI model catalogue',
};

export type {
  GuestInspection,
  InspectionProbeFailure,
  HubStatus,
} from './inspection-types.js';

/**
 * installs the latest stable managed tools into the persistent guest filesystem
 * @param sprite target guest
 * @param integrations selected direct integrations for a new installation
 */
export async function installGuestTools(
  sprite: Sprite,
  integrations?: GuestIntegrations,
): Promise<void> {
  await withGuestTransaction(
    sprite,
    async () => {
      await runGuest(sprite, [
        '/usr/bin/install',
        '-d',
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '0755',
        PAYLOAD_DIRECTORY,
        '/run/lock',
      ]);
      const isExisting = await guestFileExists(sprite, MANIFEST_PATH);
      await deployInstallerPayload(sprite);
      if (isExisting) {
        await updateGuestTools(sprite);

        return;
      }
      await runGuestInstaller(sprite, {
        script: 'install-tools.js',
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      const now = new Date().toISOString();
      const manifest: GuestManifest = {
        schema: 1,
        createdAt: now,
        lastSuccessfulUpdate: now,
        lastUpdateStatus: 'succeeded',
        installedVersions: await readInstalledVersions(sprite),
        integrations,
      };
      await writeGuestManifest(sprite, manifest);
    },
    true,
  );
}

/**
 * executes the updater under its caller's continuously held filesystem lock
 * @param sprite target guest
 */
async function updateGuestTools(sprite: Sprite): Promise<void> {
  for (const filename of [
    'update-manifest.js',
    'update-options.js',
    'update-services.js',
    'update-versions.js',
    'updater-diagnostics.js',
    'updater-lifecycle.js',
    'updater.js',
  ]) {
    await deployGuestPayload(sprite, filename, SCRIPT_MODE);
  }
  await runGuest(
    sprite,
    [
      `${PAYLOAD_DIRECTORY}/node/bin/node`,
      `${PAYLOAD_DIRECTORY}/updater.js`,
      '--force',
    ],
    { timeoutMs: UPDATE_TIMEOUT_MS, step: 'updater.js' },
  );
}

/**
 * stages root installer and agent-readable hook helpers before tool installation
 * @param sprite target guest
 */
async function deployInstallerPayload(sprite: Sprite): Promise<void> {
  await deployGuestPayload(sprite, 'install-tools.js', SCRIPT_MODE);
  await deployGuestPayload(sprite, 'update-schedule.js', AGENT_SCRIPT_MODE);
  for (const filename of [
    'guest-task-hold.js',
    'codex-hooks-trust.js',
    'native-files.js',
  ]) {
    await deployGuestPayload(sprite, filename, AGENT_SCRIPT_MODE);
  }
}

/**
 * fetches current service, route, and installation state on explicit inspection
 * @param sprite target guest
 * @param progress optional observer for actual probe starts and elapsed completions
 * @returns current service, network, native, gateway, and manifest status
 */
export async function inspectGuest(
  sprite: Sprite,
  progress?: Interaction['progress'],
): Promise<GuestInspection> {
  const manifest = await inspectStage(
    'inspection',
    async () => readGuestManifest(sprite),
    progress,
  );
  const integrations = guestIntegrations(manifest);
  const [serviceProbe, tailscaleProbe, nativeProbe, proxyProbe] =
    await Promise.allSettled([
      inspectStage('services', async () => listGuestServices(sprite), progress),
      inspectStage(
        'tailscale',
        async () =>
          integrations.tailscale
            ? inspectTailscale(sprite)
            : Promise.resolve({
                ...manifest.tailnetIdentity,
                online: false,
                dnsReady: false,
                skipped: true,
                reason: 'Tailscale is disabled',
              }),
        progress,
      ),
      inspectStage(
        'native',
        async () => inspectNativeConfiguration(sprite),
        progress,
      ),
      inspectStage(
        'proxy',
        async () =>
          integrations.cliproxyapi
            ? inspectHub(sprite)
            : Promise.resolve({
                reachable: false,
                skipped: true,
                reason: 'CLIProxyAPI is disabled',
              }),
        progress,
      ),
    ] as const);

  return settleInspectionResults(manifest, integrations, [
    serviceProbe,
    tailscaleProbe,
    nativeProbe,
    proxyProbe,
  ]);
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

/**
 * checks the selected gateway's model catalogue without generating a model turn
 * @param sprite target guest
 * @returns gateway model-catalogue reachability
 */
export async function inspectHub(sprite: Sprite): Promise<HubStatus> {
  if (
    !(await runBoundedIO(async () =>
      sprite.filesystem().exists(`${PAYLOAD_DIRECTORY}/hub-probe.js`),
    ))
  ) {
    return {
      reachable: false,
      skipped: false,
      reason: 'gateway probe is not installed',
    };
  }
  const result = await runGuest(sprite, [
    '/usr/sbin/runuser',
    '-u',
    'agent',
    '--',
    '/opt/agent-sprite/node/bin/node',
    `${PAYLOAD_DIRECTORY}/hub-probe.js`,
  ]);
  const status: unknown = JSON.parse(result.stdout);
  if (!isRecord(status) || typeof status.reachable !== 'boolean') {
    throw new Error('Gateway readiness probe returned a malformed result');
  }

  return {
    reachable: status.reachable,
    skipped: false,
    status: typeof status.status === 'number' ? status.status : undefined,
    reason: typeof status.reason === 'string' ? status.reason : undefined,
  };
}
