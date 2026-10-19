import { guestAsset } from '#adapters/guest/platform/assets';
import { ROOT_ONLY_MODE } from '#domain/guest';

import type { PeriodicJob } from '#domain/services';

/**
 * the update gate cron runs hourly as root: it takes the setup session's lock
 * without waiting and, once an update is due, runs the updater under an
 * awake hold, or skips the hour while a session holds the lock
 */
export const UPDATE_GATE_ASSET = guestAsset(
  'maintenance/update-gate.sh',
  ROOT_ONLY_MODE,
);

/**
 * the updater the gate sources: it upgrades every recorded tool through its
 * manager, restores the links, records the run and cleans up what the update
 * made outdated (recorded under `cleanup` in update-status.json), never
 * touching a daemon
 */
export const UPDATER_ASSET = guestAsset(
  'maintenance/updater.sh',
  ROOT_ONLY_MODE,
);

/** minutes between two runs of the gate */
const GATE_INTERVAL_MINUTES = 60;

/** the hourly job that runs the update gate as root */
export const UPDATE_JOB: PeriodicJob = {
  name: 'update-gate',
  everyMinutes: GATE_INTERVAL_MINUTES,
  run: { command: UPDATE_GATE_ASSET.installAs, arguments: [], account: 'root' },
};
