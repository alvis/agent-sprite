import {
  SESSION_LOCK,
  UPDATE_LOG,
  UPDATE_STATUS_PATH,
} from '#adapters/guest/platform/layout';
import { UPDATE_JOB } from '#adapters/guest/updates';
import { parseUpdateStatus } from '#domain/observations/updates';

import { CRON_ENTRY_PATH } from '../layout';

import { readEnvironment } from './environment';
import { asRoot, asRootDetached } from './execution';

import type { UpdateStatus } from '#domain/observations/updates';

import type { MachineProvider } from '../providers';

/** what one run of the scheduled entry did */
export interface ScheduledRun {
  /** exit status of the entry, the line cron runs */
  exitStatus: number;
  /** whether an update ran meanwhile, which moves the recorded start */
  updated: boolean;
}

/** what the updater recorded about its last run, with how its links ended */
export interface UpdateRecord extends UpdateStatus {
  /** `restored` or `failed`; absent before the run reached the links */
  links?: string;
}

/** the update intervals the guest records */
export interface StoredIntervals {
  /** days after the last successful update before another is due, as the stored profile holds them */
  updateDueIntervalDays: number;
  /** the same days, as the update gate reads them from the schedule */
  scheduleDueDays: number;
}

const LOCK_WAIT_SECONDS = 120;

/** one tool's outcome as the updater logs it */
export const LOGGED_OUTCOME = /^(\S+) \((\S+)\): (installed|skipped|failed)\b/;

/**
 * reads what the updater recorded about its last run, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the record, with no tools before any update ran
 */
export async function readUpdateRecord(
  provider: MachineProvider,
  name: string,
): Promise<UpdateRecord> {
  const text = await provider.execute(
    name,
    `cat ${UPDATE_STATUS_PATH} 2>/dev/null || true`,
  );
  const status = parseUpdateStatus(text) ?? { tools: [] };
  const { links } = (status.startedAt ? JSON.parse(text) : {}) as {
    links?: unknown;
  };

  return typeof links === 'string' ? { ...status, links } : status;
}

/**
 * reads each tool's outcome of the last update run
 * @param status what the updater recorded
 * @returns each tool's outcome by its name
 */
export function updateOutcomes(status: UpdateRecord): Record<string, string> {
  return Object.fromEntries(
    status.tools.map(({ name, outcome }) => [name, outcome]),
  );
}

/**
 * reads the update intervals the guest records, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the stored profile's due interval and the schedule's
 */
export async function readStoredIntervals(
  provider: MachineProvider,
  name: string,
): Promise<StoredIntervals> {
  const { profile, schedule } = await readEnvironment(provider, name);

  return {
    updateDueIntervalDays: profile.options.updateDueIntervalDays,
    scheduleDueDays: schedule.dueDays,
  };
}

/**
 * rewrites when the updater says the last update succeeded, as root, whose
 * file it is
 * @param provider selected provider
 * @param name exact workstation name
 * @param at the time to record
 */
export async function setLastSuccessfulUpdate(
  provider: MachineProvider,
  name: string,
  at: Date,
): Promise<void> {
  await asRoot(
    provider,
    name,
    [
      'set -e',
      `/usr/bin/jq --arg at '${at.toISOString()}' '.lastSuccess = $at' ${UPDATE_STATUS_PATH} > ${UPDATE_STATUS_PATH}.e2e`,
      `chmod 0644 ${UPDATE_STATUS_PATH}.e2e`,
      `mv -f ${UPDATE_STATUS_PATH}.e2e ${UPDATE_STATUS_PATH}`,
    ].join('\n'),
  );
}

/**
 * runs the update gate's line cron holds, without --force, and waits for it
 * to end: it waits for the session lock, which an update holds, to be free,
 * runs the very line cron runs, then waits for the lock again, since cron's
 * own tick may have taken it between the wait and the run and updated in the
 * entry's stead
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the entry's exit status and whether an update ran
 */
export async function runScheduledEntry(
  provider: MachineProvider,
  name: string,
): Promise<ScheduledRun> {
  const before = await readUpdateRecord(provider, name);
  await waitForUpdateLock(provider, name);
  const exitStatus = Number(
    (
      await asRootDetached(
        provider,
        name,
        [
          'set -e',
          // the line under the job's comment, without its schedule and account
          `entry=$(sed -n '/^# ${UPDATE_JOB.name}$/{n;s/^[^ ]* [^ ]* [^ ]* [^ ]* [^ ]* root //p;}' ${CRON_ENTRY_PATH})`,
          'test -n "$entry"',
          'status=0',
          '/bin/sh -c "$entry" || status=$?',
          'echo "$status"',
        ].join('\n'),
      )
    ).trim(),
  );
  await waitForUpdateLock(provider, name);
  const after = await readUpdateRecord(provider, name);

  return { exitStatus, updated: after.startedAt !== before.startedAt };
}

/**
 * waits for no update run to hold the session lock
 * @param provider selected provider
 * @param name exact workstation name
 */
async function waitForUpdateLock(
  provider: MachineProvider,
  name: string,
): Promise<void> {
  await asRootDetached(
    provider,
    name,
    [
      'set -e',
      // nothing has held the lock while it does not exist
      `test -e ${SESSION_LOCK} || exit 0`,
      'waited=0',
      `until /usr/bin/flock -n ${SESSION_LOCK} true; do waited=$((waited + 1)); test "$waited" -lt ${String(LOCK_WAIT_SECONDS)}; sleep 1; done`,
    ].join('\n'),
  );
}

/**
 * reads the log of the last update run, which each run starts anew
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the log lines
 */
export async function readUpdateLog(
  provider: MachineProvider,
  name: string,
): Promise<string[]> {
  return (await asRoot(provider, name, `cat ${UPDATE_LOG}`))
    .split('\n')
    .filter(Boolean);
}

/**
 * reads each tool's outcome as the updater logged it
 * @param log update log lines
 * @returns each tool's outcome by its name
 */
export function loggedOutcomes(log: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    log.flatMap((line) => {
      const [, tool, , outcome] = LOGGED_OUTCOME.exec(line) ?? [];

      return tool && outcome ? [[tool, outcome]] : [];
    }),
  );
}
