import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';
import { AWAKE_COMMAND, awakeCommandScript } from '#guest/idle/command';
import {
  AWAKE_DIRECTORY,
  isGovernorReport,
  MANAGED_AWAKE_DIRECTORY,
  RUN_DIRECTORY,
} from '#guest/idle/state';
import { checkOperation } from '#operation';

import { runGuest, runGuestResult, writeGuestFile } from '../guest.js';

import { COMMAND_MODE, IDLE_DIRECTORY_MODES } from './payloads/assets.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type { GovernorReport } from '#guest/idle/state';

const REPORT_TIMEOUT_MS = 30_000;

/**
 * installs the awake command and the directories the idle governor writes,
 * each with the owner and mode `IDLE_DIRECTORY_MODES` gives it: the command
 * and `run` are root-owned and only root writes them; the shared awake
 * directory holds the agent account's holders and the recorded state; and the
 * managed awake directory holds the holds root opens, which the agent account
 * reads but cannot remove. Both hold data only, never code
 * @param guest target guest, inside a guest transaction
 */
export async function installAwakeCommand(guest: GuestChannel): Promise<void> {
  await runGuest(guest, [
    '/usr/bin/install',
    '-d',
    '-o',
    'root',
    '-g',
    'root',
    '-m',
    '0755',
    `${GUEST_ROOT}/bin`,
  ]);
  const directories = [
    [RUN_DIRECTORY, IDLE_DIRECTORY_MODES.run],
    [AWAKE_DIRECTORY, IDLE_DIRECTORY_MODES.awake],
    [MANAGED_AWAKE_DIRECTORY, IDLE_DIRECTORY_MODES.managedAwake],
  ] as const;
  for (const [directory, { group, mode }] of directories) {
    await runGuest(guest, [
      '/usr/bin/install',
      '-d',
      '-o',
      'root',
      '-g',
      group,
      '-m',
      mode,
      `${GUEST_ROOT}/${directory}`,
    ]);
  }
  await writeGuestFile(guest, {
    path: AWAKE_COMMAND,
    contents: awakeCommandScript(),
    mode: COMMAND_MODE,
  });
}

/**
 * reads the idle governor's recorded state through the root report entry,
 * which reads the agent-writable record as untrusted data; the state is
 * reported, never a readiness failure, so an unreadable record becomes a reason
 * @param guest target guest
 * @returns the validated state, or why none could be read
 */
export async function inspectGovernor(
  guest: GuestChannel,
): Promise<GovernorReport> {
  try {
    const { exitCode, stdout } = await runGuestResult(
      guest,
      [GUEST_NODE, `${GUEST_KERNEL}/idle/report.js`],
      { timeoutMs: REPORT_TIMEOUT_MS },
    );
    const report: unknown = exitCode === 0 ? JSON.parse(stdout) : undefined;

    return isGovernorReport(report)
      ? report
      : { recorded: false, reason: 'the governor report is unavailable' };
  } catch {
    checkOperation();

    return { recorded: false, reason: 'the governor report is unavailable' };
  }
}
