import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { resolveTrustedFile } from './native-files.js';
import { isRecord } from './records.js';
import { mergeManifestUpdate } from './update-manifest.js';
import { updateOptions } from './update-options.js';
import { isUpdateDue } from './update-schedule.js';
import { probeInstalledVersions } from './update-versions.js';
import {
  findTrustedExecutable,
  spriteEnvironment,
} from './updater/executables.js';
import { restartManagedServices } from './updater/services.js';
import {
  recordUpdateFailure,
  updaterFailureMessage,
} from './updater-diagnostics.js';
import { runHeldUpdate } from './updater-lifecycle.js';

import type { StdioOptions } from 'node:child_process';

import type { UpdateOptions } from './update-options.js';

const manifestPath = '/opt/agent-sprite/manifest.json';
const installTimeoutMs = 1_200_000;
const lockDescriptor = 9;
const installerStdio: StdioOptions = [
  'ignore',
  'ignore',
  'ignore',
  'ignore',
  'ignore',
  'ignore',
  'ignore',
  'ignore',
  'ignore',
  lockDescriptor,
];
await runUpdater().catch((error: unknown) => {
  process.stderr.write(`${updaterFailureMessage(error)}\n`);
  process.exitCode = 1;
});

/**
 * validates the managed manifest and controls one due or forced update
 * @returns after the selected update completes
 */
async function runUpdater(): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    !isRecord(manifest) ||
    manifest.schema !== 1 ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.installedVersions !== 'object' ||
    manifest.installedVersions === null ||
    Array.isArray(manifest.installedVersions) ||
    (manifest.integrations !== undefined &&
      (!isRecord(manifest.integrations) ||
        Array.isArray(manifest.integrations) ||
        typeof manifest.integrations.tailscale !== 'boolean' ||
        typeof manifest.integrations.exitNode !== 'boolean' ||
        typeof manifest.integrations.cliproxyapi !== 'boolean'))
  ) {
    throw new Error('Managed installation manifest is malformed');
  }
  const options = updateOptions(
    {
      integrations: isRecord(manifest.integrations)
        ? { tailscale: manifest.integrations.tailscale === true }
        : undefined,
    },
    process.argv,
  );
  if (
    !options.force &&
    !isUpdateDue(
      typeof manifest.lastSuccessfulUpdate === 'string'
        ? manifest.lastSuccessfulUpdate
        : manifest.createdAt,
    )
  ) {
    return;
  }

  await mergeManifestUpdate(manifestPath, {
    lastAttemptedUpdate: new Date().toISOString(),
  });
  await performUpdate(options);
}

/**
 * records safe stage diagnostics while retaining the original failure internally
 * @param options selected update mode
 * @returns after the managed update and task hold release
 */
async function performUpdate(options: UpdateOptions): Promise<void> {
  let updateStep = 'task hold acquisition';
  let installerRan = false;
  await runHeldUpdate({
    acquire: async () => runTaskHold('acquire'),
    release: async () => runTaskHold('release'),
    work: async () => {
      updateStep = 'install-tools';
      await installTools(() => {
        installerRan = true;
      });
      updateStep = 'managed service restart preparation';
      await restartManagedServices(options.services, (step) => {
        updateStep = step;
      });
      updateStep = 'installed version probes';
      const installedVersions = await probeInstalledVersions(
        spriteEnvironment,
        (step) => {
          updateStep = step;
        },
      );
      updateStep = 'manifest update';
      await mergeManifestUpdate(manifestPath, {
        installedVersions,
        lastSuccessfulUpdate: new Date().toISOString(),
        lastUpdateStatus: 'succeeded',
      });
    },
    recordFailure: async ({
      error,
      releaseError,
      releaseOnly,
      releaseFailed,
    }) =>
      recordUpdateFailure(
        {
          step: releaseOnly ? 'task hold release' : updateStep,
          installerRan,
          releaseFailed,
        },
        error,
        releaseError,
      ),
  });
}

/**
 * validates root installer inputs and tools before running the installation
 * @param onRun records that the installer was actually started
 * @returns after the trusted installer completes
 */
async function installTools(onRun: () => void): Promise<void> {
  for (const name of [
    'install',
    'apt-get',
    'getent',
    'useradd',
    'uname',
    'curl',
    'jq',
    'mktemp',
    'rm',
    'grep',
    'sha256sum',
    'mkdir',
    'tar',
    'ln',
    'sort',
    'tail',
    'make',
    'nproc',
    'sed',
    'find',
    'head',
    'stat',
    'runuser',
  ]) {
    await findTrustedExecutable(name, [
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
    ]);
  }
  const node = await resolveTrustedFile('/opt/agent-sprite/node/bin/node');
  const installer = await resolveTrustedFile(
    '/opt/agent-sprite/install-tools.js',
  );
  onRun();
  execFileSync(node, [installer], {
    env: spriteEnvironment,
    stdio: installerStdio,
    timeout: installTimeoutMs,
  });
}

/**
 * runs the task-hold payload only through root-controlled executable paths
 * @param action hold operation
 * @returns after the hold operation completes
 */
async function runTaskHold(action: 'acquire' | 'release'): Promise<void> {
  const node = await resolveTrustedFile('/usr/local/bin/node');
  const script = await resolveTrustedFile(
    '/opt/agent-sprite/guest-task-hold.js',
  );
  execFileSync(node, [script, action, 'agent-sprite-updater'], {
    env: spriteEnvironment,
    stdio: 'ignore',
    timeout: 15_000,
  });
}
