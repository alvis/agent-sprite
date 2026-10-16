import { describe, it } from 'vitest';

import { successData } from './machines/cli';
import { sendHookEvents } from './machines/guest';
import { createMachineHarness } from './machines/harness';
import {
  crashHarnessTurn,
  isAsleep,
  openAgentConnection,
  readGovernor,
  readPauses,
  startAwakeLog,
  startHarnessTurn,
  startTickLog,
  stopAwakeLog,
  waitForToolCall,
  waitForTurnEnd,
  watchRunStates,
} from './machines/idle';
import { describeWorkstationSuite } from './machines/workstation';

import type { RunSample } from './machines/idle';

// budgets sum below the project testTimeout so a slow step fails before vitest
// abandons the test body; observed baseline lifecycles finish in about 3 minutes
const CREATE_TIMEOUT_MS = 20 * 60_000;
const READ_TIMEOUT_MS = 2 * 60_000;
// whole-second rounding and the delay between the governor's record and the Sprite's answer
const TASK_EXPIRY_TOLERANCE_MS = 3000;
const MINUTE_MS = 60_000;
// a real harness turn routes through the profile's CLIProxyAPI hub
const PROXY_REQUIRED = ['CLIPROXYAPI_BASE_URL', 'CLIPROXYAPI_API_KEY'];
const SECOND_MS = 1000;
// the Sprite reports its transitions in whole seconds
const TRANSITION_ROUNDING_MS = SECOND_MS;
// the guest's last tick lands up to a second before it stops
const PAUSE_ROUNDING_MS = 2 * SECOND_MS;
// the samples either side of a pause that show what led into and out of it
const PAUSE_CONTEXT_MS = 10 * SECOND_MS;
const IDLE_MINUTES = 1;
// a tool call well past the idle timeout
const LONG_TURN_SECONDS = 150;
// longer than the idle timeout and inside the long tool call
const LONG_QUIET_MS = 90_000;
const SHORT_TURN_SECONDS = 75;
// inside the short tool call, where nothing but the turn keeps the Sprite awake
const SHORT_QUIET_MS = 50_000;
const SHORT_HOLD_MAX_MINUTES = 2;
// a tool call that outlasts the short hold maximum
const CRASH_TURN_SECONDS = 400;
// how long the Sprite may take to sleep once nothing keeps it awake
const SLEEP_GRACE_MS = 2 * MINUTE_MS;
// how long a sleep is left undisturbed, well past the pause the guest's ticks can show
const OBSERVED_SLEEP_MS = 15_000;
// a hold refresh and the heartbeat it records are written moments apart
const HOLD_REFRESH_SKEW_MS = 5 * SECOND_MS;

/**
 * summarises run-state samples for an annotation
 * @param samples provider reads in order
 * @returns each distinct state with how often it was read
 */
function describeSamples(samples: readonly RunSample[]): string {
  const states = new Map<string, number>();
  for (const { status, lastRunningAt } of samples) {
    const key = `${status} (last running ${lastRunningAt ?? 'never'})`;
    states.set(key, (states.get(key) ?? 0) + 1);
  }

  return [...states].map(([state, count]) => `${count}x ${state}`).join(', ');
}

/**
 * reads a recorded instant, so a missing one fails every comparison
 * @param value ISO 8601 instant, or nothing when none was recorded
 * @returns epoch milliseconds, or NaN when nothing was recorded
 */
function instant(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

const harness = await createMachineHarness('sprite');
const { cli, provider } = harness;

describeWorkstationSuite(harness);

describe('Sprite awake task', () => {
  it.concurrent(
    'should keep a Sprite awake through a harness turn, then let it sleep and wake on a URL request',
    async ({ expect, signal, annotate }) => {
      const missing = PROXY_REQUIRED.filter((key) => !harness.hasValue(key));
      if (missing.length > 0) {
        throw new Error(
          `A real harness turn routes through CLIProxyAPI and needs ${missing.join(', ')} set`,
        );
      }
      const name = harness.workstationName('w');

      await harness.withWorkstation(name, async () => {
        const create = successData(
          await cli.json(
            [
              'create',
              '--name',
              name,
              '--no-git-identity',
              '--idle-minutes',
              String(IDLE_MINUTES),
              '--proxy',
              '--provider',
              'sprite',
            ],
            CREATE_TIMEOUT_MS,
            signal,
          ),
          'create',
        );
        const { holdMaxMinutes } = create.profile.options;
        const idleMs = IDLE_MINUTES * MINUTE_MS;
        const turn = { tag: 'long', sleepSeconds: LONG_TURN_SECONDS };

        expect(create.profile.options).toMatchObject({
          isProxyEnabled: true,
          idleTimeoutMinutes: IDLE_MINUTES,
        });

        // a real turn whose tool call outlasts the idle timeout: its hold,
        // not the idle timeout, sets the deadline, and the Sprite task tracks it
        await startTickLog(provider, name);
        await startHarnessTurn(provider, name, turn);
        await waitForToolCall(provider, name, turn);
        const during = await readGovernor(provider, name);
        const taskDuring = await provider.readAwakeTask(name);
        const heldMs = instant(during.deadline) - instant(during.lastHeartbeat);

        expect(during).toMatchObject({
          idleTimeoutMinutes: IDLE_MINUTES,
          openHolds: 1,
          holds: [{ source: 'claude', expiresAt: during.deadline }],
        });
        expect(heldMs).toBeGreaterThan(idleMs);
        expect(heldMs).toBeLessThanOrEqual(holdMaxMinutes * MINUTE_MS);
        expect(
          Math.abs(instant(taskDuring) - instant(during.deadline)),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        // nothing touches the guest for longer than the idle timeout, so only
        // the turn keeps the Sprite running
        const quiet = await watchRunStates(provider, name, {
          durationMs: LONG_QUIET_MS,
        });

        expect(quiet.length).toBeGreaterThan(0);
        expect(quiet.filter(({ status }) => status !== 'running')).toEqual([]);

        const outcome = await waitForTurnEnd(provider, name, turn);
        const after = await readGovernor(provider, name);
        // the turn-end hook records the last heartbeat and the harness exits
        // after it; a pause's last tick lands up to a second before it begins
        const turnPauses = (
          await readPauses(provider, name, outcome.startedAt)
        ).filter(
          ({ from }) =>
            Date.parse(from) + PAUSE_ROUNDING_MS < instant(after.lastHeartbeat),
        );

        expect(outcome).toMatchObject({
          exitCode: 0,
          reply: expect.stringMatching(/done/i),
        });
        expect(
          Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt),
        ).toBeGreaterThan(LONG_TURN_SECONDS * SECOND_MS);
        // the guest's own clock ran without a gap through the whole turn
        expect(turnPauses).toEqual([]);
        // turn end closed the hold; only the idle timeout remains
        expect(after).toMatchObject({ openHolds: 0, holds: [] });
        expect(instant(after.deadline) - instant(after.lastHeartbeat)).toBe(
          idleMs,
        );

        // with no turn and nothing touching the guest, the Sprite sleeps once
        // the idle timeout has passed, and not before; the provider's own
        // record is read when it carries transition times
        const settling = await watchRunStates(provider, name, {
          durationMs: instant(after.deadline) - Date.now() + SLEEP_GRACE_MS,
          until: isAsleep,
          settleMs: OBSERVED_SLEEP_MS,
        });
        const asleep = settling.findLast(isAsleep);

        expect(
          settling.filter(
            ({ at, status }) =>
              Date.parse(at) < instant(after.deadline) && status !== 'running',
          ),
        ).toEqual([]);

        // a request to the public URL wakes the Sprite and the ACP agent answers
        const url = await provider.readUrl(name);
        const requestedAt = Date.now();
        const page = await fetch(url, { signal });
        const environment = await fetch(
          new URL('/.well-known/t3/environment', url),
          { signal },
        );
        const respondedAt = Date.now();

        expect({
          status: page.status,
          type: page.headers.get('content-type'),
        }).toEqual({ status: 200, type: expect.stringContaining('text/html') });
        expect(environment.status).toBe(200);
        expect(await environment.json()).toEqual(
          expect.objectContaining({ environmentId: expect.any(String) }),
        );

        // the Sprite may serve the request and sleep again at once, so its
        // last transition to running is the provider's evidence
        const woken = (
          await watchRunStates(provider, name, {
            durationMs: READ_TIMEOUT_MS,
            until: ({ lastRunningAt }) =>
              instant(lastRunningAt) >= requestedAt - TRANSITION_ROUNDING_MS,
          })
        ).at(-1);
        // the guest's own clock is the authoritative evidence: it stopped once
        // the deadline passed and ran again only for the request
        const [sleep] = await readPauses(provider, name, outcome.endedAt);

        await annotate(
          `deadline ${String(after.deadline)}: the guest stopped after its tick at ${String(sleep?.from)} (${instant(sleep?.from) - instant(after.deadline)} ms after the deadline) and ran again at ${String(sleep?.to)}; the provider recorded sleep at ${String(asleep?.lastWarmingAt)} (${instant(asleep?.lastWarmingAt) - instant(after.deadline)} ms, whole seconds)`,
        );
        await annotate(
          `the URL request at ${new Date(requestedAt).toISOString()} was answered by ${new Date(respondedAt).toISOString()}; the provider then recorded running from ${String(woken?.lastRunningAt)}, now ${String(woken?.status)}`,
        );
        expect(instant(sleep?.from)).toBeGreaterThanOrEqual(
          instant(after.deadline) - PAUSE_ROUNDING_MS,
        );
        expect(instant(sleep?.from)).toBeLessThanOrEqual(
          instant(after.deadline) + SLEEP_GRACE_MS,
        );
        // the guest and host clocks agree to well under a second
        expect(instant(sleep?.to)).toBeGreaterThanOrEqual(
          requestedAt - TRANSITION_ROUNDING_MS,
        );
        expect(instant(sleep?.to)).toBeLessThanOrEqual(
          respondedAt + TRANSITION_ROUNDING_MS,
        );
        // the request reached the agent, not a harness: the governor saw nothing
        expect(await readGovernor(provider, name)).toEqual(after);
        // the idle cycle left every supervised service running
        const services = await provider.snapshotServices(name);

        expect(services.length).toBeGreaterThan(0);
        expect(services.filter(({ status }) => status !== 'running')).toEqual(
          [],
        );

        // an open ACP connection without harness activity adds no heartbeat,
        // no hold and no Sprite task
        const connection = await openAgentConnection(provider, name, url);
        const openedAt = Date.now();
        const connected = await watchRunStates(provider, name, {
          durationMs: idleMs + MINUTE_MS,
        });
        const heldOpen = connection.isOpen();
        const connectedPauses = (
          await readPauses(provider, name, new Date(openedAt).toISOString())
        ).filter(({ from }) => Date.parse(from) < Date.now());
        const governed = await readGovernor(provider, name);
        const taskConnected = await provider.readAwakeTask(name);
        await connection.close();
        const closedAt = Date.now();
        const released = await watchRunStates(provider, name, {
          durationMs: SLEEP_GRACE_MS,
          until: isAsleep,
          settleMs: OBSERVED_SLEEP_MS,
        });
        const [releasedSleep] = await readPauses(
          provider,
          name,
          new Date(closedAt).toISOString(),
        );

        await annotate(
          `while the ACP connection stayed open for ${closedAt - openedAt} ms the provider reported ${describeSamples(connected)} and the guest paused ${JSON.stringify(connectedPauses)}; after it closed the guest stopped after its tick at ${String(releasedSleep?.from)} (${instant(releasedSleep?.from) - closedAt} ms later) and the provider recorded sleep at ${String(released.findLast(isAsleep)?.lastWarmingAt)}`,
        );
        expect(heldOpen).toBe(true);
        expect(governed).toEqual(after);
        expect(taskConnected).toBeUndefined();
        expect(instant(releasedSleep?.from)).toBeLessThanOrEqual(
          closedAt + SLEEP_GRACE_MS,
        );
      });
    },
  );

  it.concurrent(
    'should delete the Sprite task when the last hold closes and the idle timeout is 0',
    async ({ expect, signal, annotate }) => {
      const name = harness.workstationName('z');

      await harness.withWorkstation(name, async () => {
        successData(
          await cli.json(
            [
              'create',
              '--name',
              name,
              '--no-git-identity',
              '--idle-minutes',
              '0',
              '--hold-max-minutes',
              String(SHORT_HOLD_MAX_MINUTES),
              '--proxy',
              '--provider',
              'sprite',
            ],
            CREATE_TIMEOUT_MS,
            signal,
          ),
          'create',
        );

        const steps = await sendHookEvents(provider, name, {
          harness: 'codex',
          session: name,
          actions: ['hold-open', 'hold-close'],
        });

        expect(steps).toEqual([
          expect.objectContaining({
            action: 'hold-open',
            exitCode: 0,
            openHolds: 1,
            deadline: expect.any(String),
            taskExpiresAt: expect.any(String),
          }),
          expect.objectContaining({
            action: 'hold-close',
            exitCode: 0,
            openHolds: 0,
            deadline: undefined,
            taskExpiresAt: undefined,
          }),
        ]);
        expect(
          Math.abs(
            instant(steps[0]!.taskExpiresAt) - instant(steps[0]!.deadline),
          ),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        // a real turn still keeps the Sprite awake with an idle timeout of 0
        const turn = { tag: 'held', sleepSeconds: SHORT_TURN_SECONDS };

        await startTickLog(provider, name);
        await startAwakeLog(provider, name);
        await startHarnessTurn(provider, name, turn);
        await waitForToolCall(provider, name, turn);
        const during = await readGovernor(provider, name);
        const taskDuring = await provider.readAwakeTask(name);

        expect(during).toMatchObject({
          idleTimeoutMinutes: 0,
          openHolds: 1,
          holds: [{ source: 'claude', expiresAt: during.deadline }],
        });
        expect(
          Math.abs(instant(taskDuring) - instant(during.deadline)),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        const quiet = await watchRunStates(provider, name, {
          durationMs: SHORT_QUIET_MS,
        });

        expect(quiet.length).toBeGreaterThan(0);
        expect(quiet.filter(({ status }) => status !== 'running')).toEqual([]);

        // no keep-awake task outlives the turn, and the Sprite then sleeps
        const outcome = await waitForTurnEnd(provider, name, turn);
        const after = await readGovernor(provider, name);
        // the turn-end hook records the last heartbeat and the harness exits
        // after it; a pause's last tick lands up to a second before it begins
        const turnPauses = (
          await readPauses(provider, name, outcome.startedAt)
        ).filter(
          ({ from }) =>
            Date.parse(from) + PAUSE_ROUNDING_MS < instant(after.lastHeartbeat),
        );
        const taskAfter = await provider.readAwakeTask(name);
        // whether the Sprite held the awake task at every second of the turn,
        // and what it and the governor recorded around any pause in it
        const samples = await stopAwakeLog(provider, name, {
          from: outcome.startedAt,
          to: new Date().toISOString(),
        });
        const turnSamples = samples.filter(
          ({ at }) => Date.parse(at) <= instant(after.lastHeartbeat),
        );
        const taskless = turnSamples.filter(
          ({ taskExpiresAt }) => taskExpiresAt === undefined,
        );

        await annotate(
          `idle 0 awake task: present in ${turnSamples.length - taskless.length} of ${turnSamples.length} samples from the turn's start at ${outcome.startedAt} to the turn-end hook; missing at ${taskless.map(({ at }) => at).join(', ') || 'no sample'}; during the tool call the governor's deadline was ${String(during.deadline)} and the task expired at ${String(taskDuring)}; after the turn the task expired at ${String(taskAfter)}`,
        );
        for (const pause of turnPauses) {
          await annotate(
            `idle 0 pause ${JSON.stringify(pause)} during the turn; samples around it: ${JSON.stringify(
              samples.filter(
                ({ at }) =>
                  Date.parse(at) >= Date.parse(pause.from) - PAUSE_CONTEXT_MS &&
                  Date.parse(at) <= Date.parse(pause.to) + PAUSE_CONTEXT_MS,
              ),
            )}`,
          );
        }
        const lastReadAt = Date.now();
        const settled = (
          await watchRunStates(provider, name, {
            durationMs: SLEEP_GRACE_MS,
            until: isAsleep,
            settleMs: OBSERVED_SLEEP_MS,
          })
        ).findLast(isAsleep);
        const [idleSleep] = await readPauses(
          provider,
          name,
          new Date(lastReadAt - PAUSE_ROUNDING_MS).toISOString(),
        );

        await annotate(
          `idle 0: the turn-end hook ran at ${String(after.lastHeartbeat)}; after the last guest read the guest stopped after its tick at ${String(idleSleep?.from)} (${instant(idleSleep?.from) - lastReadAt} ms later) and the provider recorded sleep at ${String(settled?.lastWarmingAt)}`,
        );
        expect(outcome).toMatchObject({ exitCode: 0 });
        expect(turnPauses).toEqual([]);
        expect(after).toMatchObject({
          openHolds: 0,
          holds: [],
          deadline: undefined,
        });
        expect(taskAfter).toBeUndefined();
        expect(instant(idleSleep?.from)).toBeLessThanOrEqual(
          lastReadAt + SLEEP_GRACE_MS,
        );

        // a turn that crashes before its turn-end hook keeps its hold only
        // until the hold maximum after its last refresh, then the Sprite sleeps
        const crashed = { tag: 'crashed', sleepSeconds: CRASH_TURN_SECONDS };

        await startHarnessTurn(provider, name, crashed);
        await waitForToolCall(provider, name, crashed);
        await crashHarnessTurn(provider, name, crashed);
        const crashOutcome = await waitForTurnEnd(provider, name, crashed);
        const orphaned = await readGovernor(provider, name);
        const taskOrphaned = await provider.readAwakeTask(name);
        const [orphanHold] = orphaned.holds;
        const orphanMs =
          instant(orphanHold?.expiresAt) - instant(orphaned.lastHeartbeat);

        expect(crashOutcome.exitCode).toBe(137);
        expect(orphaned).toMatchObject({
          openHolds: 1,
          holds: [{ source: 'claude', expiresAt: orphaned.deadline }],
        });
        expect(orphanMs).toBeLessThanOrEqual(
          SHORT_HOLD_MAX_MINUTES * MINUTE_MS,
        );
        expect(orphanMs).toBeGreaterThan(
          SHORT_HOLD_MAX_MINUTES * MINUTE_MS - HOLD_REFRESH_SKEW_MS,
        );
        expect(
          Math.abs(instant(taskOrphaned) - instant(orphaned.deadline)),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        const orphanedReadAt = Date.now();
        const expiring = await watchRunStates(provider, name, {
          durationMs: instant(orphaned.deadline) - Date.now() + SLEEP_GRACE_MS,
          until: isAsleep,
          settleMs: OBSERVED_SLEEP_MS,
        });
        const [expirySleep] = await readPauses(
          provider,
          name,
          new Date(orphanedReadAt).toISOString(),
        );

        await annotate(
          `crashed turn: the orphaned hold expired ${String(orphaned.deadline)}; the guest stopped after its tick at ${String(expirySleep?.from)} (${instant(expirySleep?.from) - instant(orphaned.deadline)} ms after it) and the provider recorded sleep at ${String(expiring.findLast(isAsleep)?.lastWarmingAt)}`,
        );
        // the orphaned hold alone kept the Sprite running until it expired
        expect(
          expiring.filter(
            ({ at, status }) =>
              Date.parse(at) < instant(orphaned.deadline) &&
              status !== 'running',
          ),
        ).toEqual([]);
        expect(instant(expirySleep?.from)).toBeGreaterThanOrEqual(
          instant(orphaned.deadline) - PAUSE_ROUNDING_MS,
        );
        expect(instant(expirySleep?.from)).toBeLessThanOrEqual(
          instant(orphaned.deadline) + SLEEP_GRACE_MS,
        );
      });
    },
  );
});
