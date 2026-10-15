import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from './guest-root.js';
import { isRecord } from './records.js';

/** days after the last successful update before another is due when the stored profile names none */
export const DEFAULT_UPDATE_DUE_DAYS = 1;

/** longest due interval: one year */
export const MAX_UPDATE_DUE_DAYS = 365;

/**
 * directory of the update lock: under the guest root, which only root writes,
 * and root-only itself, so no other account can create, hold or replace the
 * lock or plant a link in its place. It is its own directory, not the idle
 * governor's `run` directory, which stays world-traversable so the agent
 * account can reach the awake holds and so cannot satisfy the lock's 0700 check
 */
export const UPDATE_LOCK_DIRECTORY = `${GUEST_ROOT}/lock`;

/** lock every update run holds, so one update runs at a time */
export const UPDATE_LOCK_PATH = `${UPDATE_LOCK_DIRECTORY}/update.lock`;

/** tools the update entry runs as root before it reaches the updater */
export const UPDATE_ENTRY_TOOLS = [
  '/bin/mkdir',
  '/usr/bin/find',
  '/usr/bin/flock',
] as const;

const dayMs = 86_400_000;

/** the days an update stays undue, and why the default replaced the stored value */
export interface UpdateDueDays {
  /** days after the last successful update before another is due */
  days: number;
  /** set when the stored profile had no usable value and the default applies */
  diagnostic?: string;
}

/**
 * builds the shell command that makes the update lock's directory and then
 * succeeds only when that directory is a real directory (not a link) owned by
 * the owner with mode 0700, so the lock is never opened in a directory
 * another account controls. It holds no single quote and no percent sign, so
 * it nests in a cron entry
 * @param directory absolute directory of the lock
 * @param owner account that must own the directory, by name or id
 * @returns the shell command line
 */
export function lockDirectoryCommand(
  directory = UPDATE_LOCK_DIRECTORY,
  owner = 'root',
): string {
  return `/bin/mkdir -p -m 0700 ${directory} && test -n "$(/usr/bin/find ${directory} -maxdepth 0 -type d -user ${owner} -perm 0700)"`;
}

/**
 * builds the shell command of one scheduled update check: it checks the
 * root-only lock directory, takes the update lock without waiting, and then
 * replaces the shell with the updater, which ends at once when no update is
 * due. Every timer runs it as `/bin/sh -c`; the cron entry is one consumer,
 * and it holds no single quote, so it nests in one quoted shell argument.
 * @returns the shell command line
 */
export function updateEntryCommand(): string {
  return `${lockDirectoryCommand()} || exit 0; exec 9>>${UPDATE_LOCK_PATH}; /usr/bin/flock -n 9 || exit 0; exec ${GUEST_NODE} ${GUEST_KERNEL}/updater.js`;
}

/**
 * reads the due interval from the stored profile, never failing an update;
 * only the due-interval field decides, so an unrelated profile defect cannot
 * hide a valid value
 * @param profile decoded profile of the installation manifest
 * @returns the stored days, or the default with the reason it applies
 */
export function storedDueDays(profile: unknown): UpdateDueDays {
  const days =
    isRecord(profile) && isRecord(profile.options)
      ? profile.options.updateDueIntervalDays
      : undefined;
  if (
    typeof days === 'number' &&
    Number.isSafeInteger(days) &&
    days >= 1 &&
    days <= MAX_UPDATE_DUE_DAYS
  ) {
    return { days };
  }

  return {
    days: DEFAULT_UPDATE_DUE_DAYS,
    diagnostic: `The stored profile has no valid update due interval (1 to ${String(MAX_UPDATE_DUE_DAYS)} days); using ${String(DEFAULT_UPDATE_DUE_DAYS)} days`,
  };
}

/**
 * decides whether the due interval has elapsed since the last successful installation
 * @param lastSuccessfulUpdate recorded successful-update time or creation time
 * @param dueDays whole days after which maintenance is due
 * @param nowMs current epoch time in milliseconds
 * @returns whether maintenance is due, including an invalid recorded time
 */
export function isUpdateDue(
  lastSuccessfulUpdate: string,
  dueDays: number,
  nowMs = Date.now(),
): boolean {
  const lastSuccessMs = Date.parse(lastSuccessfulUpdate);

  return (
    !Number.isFinite(lastSuccessMs) || nowMs - lastSuccessMs >= dueDays * dayMs
  );
}
