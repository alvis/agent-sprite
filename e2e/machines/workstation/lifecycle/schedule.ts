import { successData } from '../../cli';
import {
  exposedEntries,
  guestEntries,
  readStoredIntervals,
  readUpdateRecord,
  runScheduledEntry,
  setLastSuccessfulUpdate,
} from '../../guest';
import { SECOND_MS } from '../../timing';
import { COMMAND_TIMEOUT_MS } from '../limits';

import type { RunningLifecycle } from '../context';

const DAY_MS = 86_400_000;
const UPDATE_DUE_DAYS = 3;
const RESCHEDULED_DUE_DAYS = 5;
const STALE_DUE_DAYS = 4;

/**
 * checks that the scheduled update runs only when due
 * @param context run drivers and prior observations
 */
export async function checkDueSchedule(
  context: RunningLifecycle,
): Promise<void> {
  const { name, expect, create, before, harness } = context;
  const { provider } = harness;
  // the due interval the create recorded drives the guest: the stored
  // profile and the schedule hold it, and the scheduled entry, run
  // without --force, updates only once the due days have passed
  expect(create.profile.options).toMatchObject({
    updateDueIntervalDays: UPDATE_DUE_DAYS,
  });
  expect(await readStoredIntervals(provider, name)).toEqual({
    updateDueIntervalDays: UPDATE_DUE_DAYS,
    scheduleDueDays: UPDATE_DUE_DAYS,
  });

  const scheduledStartedAt = Date.now();
  // the updater records whole seconds
  const scheduledSecond =
    Math.floor(scheduledStartedAt / SECOND_MS) * SECOND_MS;
  const recent = new Date(scheduledStartedAt - 2 * DAY_MS);
  await setLastSuccessfulUpdate(provider, name, recent);
  const skippedRun = await runScheduledEntry(provider, name);

  // the gate found the update not due: it ended cleanly and ran nothing
  expect(skippedRun).toEqual({ exitStatus: 0, updated: false });
  expect((await readUpdateRecord(provider, name)).lastSuccess).toBe(
    recent.toISOString(),
  );

  await setLastSuccessfulUpdate(
    provider,
    name,
    new Date(scheduledStartedAt - STALE_DUE_DAYS * DAY_MS),
  );
  const dueRun = await runScheduledEntry(provider, name);
  const statusDue = await readUpdateRecord(provider, name);

  expect(dueRun).toEqual({ exitStatus: 0, updated: true });
  expect(statusDue).toMatchObject({
    finishedAt: expect.any(String),
    links: 'restored',
  });
  expect(Date.parse(statusDue.startedAt ?? '')).toBeGreaterThanOrEqual(
    scheduledSecond,
  );
  expect(Date.parse(statusDue.lastSuccess ?? '')).toBeGreaterThanOrEqual(
    scheduledSecond,
  );
  expect(await provider.snapshotServices(name)).toEqual(before);
}

/**
 * checks the changed due interval and unchanged services
 * @param context run drivers and prior observations
 */
export async function checkRescheduledUpdate(
  context: RunningLifecycle,
): Promise<void> {
  const { cli, name, signal, expect, id, before, harness } = context;
  const { provider } = harness;
  // a later setup changes the due interval, and starts, stops and
  // restarts nothing
  const rescheduled = successData(
    await cli.json(
      [
        'setup',
        name,
        '--section',
        'tools',
        '--update-due-days',
        String(RESCHEDULED_DUE_DAYS),
      ],
      COMMAND_TIMEOUT_MS,
      signal,
    ),
    'setup',
  );

  expect(rescheduled).toMatchObject({
    section: 'tools',
    tools: 'scheduled',
    machine: { name, id },
  });
  expect(await readStoredIntervals(provider, name)).toEqual({
    updateDueIntervalDays: RESCHEDULED_DUE_DAYS,
    scheduleDueDays: RESCHEDULED_DUE_DAYS,
  });
  expect(await provider.snapshotServices(name)).toEqual(before);

  // four days is now below the due interval, so the same entry skips
  const stale = new Date(Date.now() - STALE_DUE_DAYS * DAY_MS);
  await setLastSuccessfulUpdate(provider, name, stale);
  const staleRun = await runScheduledEntry(provider, name);

  expect(staleRun).toEqual({ exitStatus: 0, updated: false });
  expect((await readUpdateRecord(provider, name)).lastSuccess).toBe(
    stale.toISOString(),
  );
  // the cron entry and the lock the runs used are root-only
  expect(exposedEntries(await guestEntries(provider, name))).toEqual([]);
  expect(await provider.snapshotServices(name)).toEqual(before);
}

/**
 * checks doctor and terminal cleanup
 * @param context run drivers and prior observations
 */
export async function checkDoctorAndTerminate(
  context: RunningLifecycle,
): Promise<void> {
  const { cli, name, signal, expect, id, harness } = context;
  const { cleanup } = harness;
  const doctor = successData(
    await cli.json(['doctor', name], COMMAND_TIMEOUT_MS, signal),
    'doctor',
  );

  expect(doctor).toMatchObject({
    machine: { name, id },
    currentReadiness: { ready: true, failures: [] },
  });

  const terminate = successData(
    await cli.json(['terminate', name, '--yes'], COMMAND_TIMEOUT_MS, signal),
    'terminate',
  );

  expect(terminate).toMatchObject({
    workstation: { status: 'deleted', id, name },
    network: {
      status: 'deleted',
    },
  });

  await cleanup.proveAbsent(name);
}
