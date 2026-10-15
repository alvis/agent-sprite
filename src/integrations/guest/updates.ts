import { guestAsset } from '#guest/assets';
import { GUEST_ROOT } from '#guest/guest-root';
import { ROOT_ONLY_MODE } from '#os/contracts';

import type { PeriodicJob } from '#os/contracts';

/**
 * the update gate cron runs hourly as root: it takes the update lock and
 * runs the updater under an awake hold once an update is due
 */
export const UPDATE_GATE_ASSET = guestAsset(
  'guest/update-gate.sh',
  ROOT_ONLY_MODE,
);

/**
 * the updater the gate sources: it upgrades every recorded tool through its
 * manager, restores the links and records the run, never touching a daemon
 */
export const UPDATER_ASSET = guestAsset('guest/updater.sh', ROOT_ONLY_MODE);

/** where the updater records its last run, which every account reads */
export const UPDATE_STATUS_PATH = `${GUEST_ROOT}/update-status.json`;

/** minutes between two runs of the gate */
const GATE_INTERVAL_MINUTES = 60;

/** the hourly job that runs the update gate as root */
export const UPDATE_JOB: PeriodicJob = {
  name: 'update-gate',
  everyMinutes: GATE_INTERVAL_MINUTES,
  run: { command: UPDATE_GATE_ASSET.installAs, arguments: [], account: 'root' },
};
