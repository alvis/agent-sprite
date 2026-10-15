import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

import { OUTCOMES_PATH, readComponentOutcomes } from './component-outcome.js';
import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from './guest-root.js';
import { withAwakeHold } from './idle/hold.js';
import { resolveTrustedFile } from './native-files.js';
import { isRecord } from './records.js';
import { runChild } from './run-child.js';
import { mergeManifestUpdate } from './update-manifest.js';
import { updateOptions } from './update-options.js';
import {
  checkIntervalDiagnostic,
  isUpdateDue,
  storedDueDays,
  UPDATE_CHECK_FILE,
} from './update-schedule.js';
import { probeInstalledVersions } from './update-versions.js';
import { findTrustedExecutable } from './updater/executables.js';
import {
  recordUpdateFailure,
  updaterFailureMessage,
} from './updater-diagnostics.js';

import type { StdioOptions } from 'node:child_process';

const manifestPath = `${GUEST_ROOT}/manifest.json`;
// the environment root gives the installer and the version probes
const updateEnvironment = {
  HOME: '/root',
  PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
};
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
    Array.isArray(manifest.installedVersions)
  ) {
    throw new Error('Managed installation manifest is malformed');
  }
  const options = updateOptions(process.argv);
  // a profile without a usable due interval never blocks an update
  const due = storedDueDays(manifest.profile);
  await recordScheduleDiagnostic(manifest, due.diagnostic);
  if (
    !options.force &&
    !isUpdateDue(
      typeof manifest.lastSuccessfulUpdate === 'string'
        ? manifest.lastSuccessfulUpdate
        : manifest.createdAt,
      due.days,
    )
  ) {
    return;
  }

  await mergeManifestUpdate(manifestPath, {
    lastAttemptedUpdate: new Date().toISOString(),
  });
  await performUpdate();
}

/**
 * records why the schedule runs on a fallback, because the cron entry discards
 * every message: the stored due interval's reason and the interval file's
 * reason, or nothing once both are valid
 * @param manifest decoded installation manifest the run read
 * @param dueDiagnostic reason the default due interval applies, when it does
 * @returns after the manifest names the current reasons
 */
async function recordScheduleDiagnostic(
  manifest: Record<string, unknown>,
  dueDiagnostic: string | undefined,
): Promise<void> {
  const diagnostics = [
    dueDiagnostic,
    checkIntervalDiagnostic(
      await readFile(UPDATE_CHECK_FILE, 'utf8').catch(() => undefined),
    ),
  ].filter((diagnostic) => diagnostic !== undefined);
  const lastUpdateDiagnostic =
    diagnostics.length > 0 ? diagnostics.join('. ') : null;
  if (lastUpdateDiagnostic !== null) {
    process.stderr.write(`${lastUpdateDiagnostic}\n`);
  }
  if ((lastUpdateDiagnostic ?? undefined) !== manifest.lastUpdateDiagnostic) {
    await mergeManifestUpdate(manifestPath, { lastUpdateDiagnostic });
  }
}

/**
 * installs in place and records the result, never touching a running service,
 * and keeps safe stage diagnostics while retaining the original failure
 * internally; the workstation stays awake through an awake hold of the
 * governor while the install runs
 * @returns after the managed update completes and its awake hold closes
 */
async function performUpdate(): Promise<void> {
  const progress = { step: 'install-tools', installerRan: false };
  try {
    await withAwakeHold(
      { source: 'updater', session: randomUUID() },
      async () => {
        await installTools(() => {
          progress.installerRan = true;
        });
        progress.step = 'installed version probes';
        const componentOutcomes = await readComponentOutcomes();
        const installedVersions = await probeInstalledVersions(
          updateEnvironment,
          (step) => {
            progress.step = step;
          },
        );
        progress.step = 'manifest update';
        await mergeManifestUpdate(manifestPath, {
          installedVersions,
          componentOutcomes: componentOutcomes ?? null,
          lastSuccessfulUpdate: new Date().toISOString(),
          lastUpdateStatus: 'succeeded',
        });
      },
    );
  } catch (error) {
    throw await recordUpdateFailure(
      {
        step: progress.step,
        installerRan: progress.installerRan,
        componentOutcomes: progress.installerRan
          ? await readComponentOutcomes().catch(() => undefined)
          : undefined,
      },
      error,
    );
  }
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
    'groupadd',
    'useradd',
    'usermod',
    'id',
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
    'bash',
    'sed',
    'find',
    'head',
    'stat',
    'runuser',
    'mv',
    'readlink',
    'chmod',
    'basename',
    'xz',
  ]) {
    await findTrustedExecutable(name, [
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
    ]);
  }
  const node = await resolveTrustedFile(GUEST_NODE);
  const installer = await resolveTrustedFile(
    `${GUEST_KERNEL}/install-tools.js`,
  );
  // an outcomes file left by an earlier run must never be read as this run's
  await rm(OUTCOMES_PATH, { force: true });
  onRun();
  // waited for without blocking, so the awake hold keeps refreshing
  await runChild(node, [installer], {
    env: updateEnvironment,
    stdio: installerStdio,
    timeoutMs: installTimeoutMs,
  });
}
