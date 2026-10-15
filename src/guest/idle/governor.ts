import { applyLatestDeadline } from './apply.js';
import { awakeDirectory, stateLock } from './context.js';
import {
  describe,
  ENTER_IDLE_FORM_LIMIT_MS,
  enterIdleForm,
} from './dispatch.js';
import { withAwakeLock } from './lock.js';
import { recompute } from './recompute.js';
import { writeGovernorState } from './state-file.js';
import { DIAGNOSTIC_LIMIT } from './state.js';
import { readTick, writeTick } from './tick-record.js';

import type { ProviderComponent } from '../../drivers/component-types.js';

import type { AwakeEvent } from './command.js';
import type { GovernorContext } from './context.js';
import type { Recompute, RecomputeRequest } from './recompute.js';
import type { AdapterResult, GovernorState } from './state.js';

// guest kernel: imports only other guest code, and names no provider. Every
// awake event and every tick recomputes the deadline under the caller's state
// lock from the holders of both awake directories, the stored profile and the
// provider the host recorded, then dispatches on the provider's keep-awake
// mode alone: `native-deadline` hands every new deadline to the adapter as the
// agent account, `governed` enters an idle form from a root tick once the
// deadline passed and sleep is permitted, and `none` only records the state.
// No adapter call runs under the state lock, so a slow adapter never makes a
// later event wait past its limit

const MINUTE_MS = 60_000;

/**
 * how long an idle-form call that outlasted its limit still counts as running,
 * so no tick starts another while it may be: the limit and as long again
 */
const IDLE_FORM_IN_FLIGHT_MS = 2 * ENTER_IDLE_FORM_LIMIT_MS;

/** what a record made without the lock carries */
type UnlockedRecord = Omit<RecomputeRequest, 'prune'> & {
  /** why the lock was not used */
  failure: string;
};

/** what a tick decided under its lock */
interface TickDecision {
  /** the recorded state */
  state: GovernorState;
  /** the provider to enter an idle form on, when one is due */
  provider?: ProviderComponent;
  /** epoch milliseconds the idle-form call was marked in flight */
  enteringSince?: number;
}

/**
 * records one awake event, recomputes the deadline and, for a
 * `native-deadline` provider, hands the latest deadline to its adapter as the
 * agent account whether or not sleep is permitted; a failed write counts as
 * idleness and is recorded
 * @param context guest root, owners, account, clock and trust check
 * @param event the validated event
 * @returns the recorded governor state
 */
export async function handleAwakeEvent(
  context: GovernorContext,
  event: AwakeEvent,
): Promise<GovernorState> {
  const recorded = await recordLocked(context, { event, prune: true });
  const { provider } = recorded;
  if (
    provider?.keepAwakeMode !== 'native-deadline' ||
    provider.awakeAdapter === undefined
  ) {
    return recorded.state;
  }
  // uid 0 never imports a native-deadline adapter: root hands the apply to a
  // child running as the agent account
  const adapter = context.asRoot
    ? await context.applyAsAgent()
    : await applyLatestDeadline(context);

  // an event the first section could not record is still reported after the apply
  const { eventFailure } = recorded;

  return (
    await recordLocked(
      context,
      { notes: eventFailure === undefined ? [] : [eventFailure], prune: true },
      adapter,
    )
  ).state;
}

/**
 * recomputes and records the state without an event, noting why an event was
 * refused; no adapter is called
 * @param context guest root, owners, account, clock and trust check
 * @param notes non-secret notes to record
 * @returns the recorded governor state
 */
export async function recordGovernorState(
  context: GovernorContext,
  notes: readonly string[],
): Promise<GovernorState> {
  return (await recordLocked(context, { notes, prune: true })).state;
}

/**
 * the periodic entry a supervisor or timer runs as root: it recomputes the
 * state and, for a `governed` provider whose deadline has passed and whose
 * sleep is permitted, enters the provider's idle form, recording a failure for
 * the next tick to retry. The runner must tick at least every 3 minutes
 * (TICK_RESUME_GAP_MS): a longer gap means the workstation slept, so the
 * governor grants a full idle timeout again, and a runner slower than that
 * would never let the workstation sleep. After an idle form is entered, or
 * the first time it ticks, a full idle timeout passes before it may sleep
 * again. No tick starts an idle-form call while an earlier one may still be
 * running, and a tick never throws: a tick that cannot take its lock records
 * why and returns
 * @param context guest root, owners, account, clock and trust check
 * @returns the recorded governor state
 */
export async function tick(context: GovernorContext): Promise<GovernorState> {
  const decision = await locked(context, async () => decideTick(context));
  if ('failure' in decision) {
    return (await recordUnlocked(context, { failure: decision.failure })).state;
  }
  const { provider, enteringSince } = decision.value;
  if (!provider || enteringSince === undefined) {
    return decision.value.state;
  }
  // entering an idle form can outlast the lock's stale age, so it runs unlocked
  const { adapter, isInFlight } = await enterIdleForm(context, provider);
  const settled = await locked(context, async () => {
    const recorded = await recordState(context, { prune: true }, adapter);
    const now = context.now();
    const { awakeSince, enteringSince: marked } = await readTick(context, now);
    // the marker stays while the call may still run, and is cleared only by
    // the tick that set it; an entered idle form, or a call that ended without
    // an answer and may have frozen the machine, keeps no awakeSince, so the
    // first tick after a resume starts the grace. A resume the boot clock saw
    // already restarted it in the read above and dropped the marker
    await writeTick(context, {
      lastTickAt: now,
      ...(adapter.result === undefined && { awakeSince }),
      ...(marked !== undefined &&
        (isInFlight || marked !== enteringSince) && { enteringSince: marked }),
    });

    return recorded;
  });

  return 'failure' in settled
    ? (await recordUnlocked(context, { failure: settled.failure }, adapter))
        .state
    : settled.value.state;
}

/**
 * recomputes the state under the caller's lock and decides whether a tick
 * enters an idle form, marking the call in flight when it does
 * @param context guest root, owners, account, clock and trust check
 * @returns the recorded state, and the provider when an idle form is due
 */
async function decideTick(context: GovernorContext): Promise<TickDecision> {
  const { provider, state } = await recompute(context, { prune: true });
  const now = context.now();
  const { awakeSince, enteringSince } = await readTick(context, now);
  const isInFlight =
    enteringSince !== undefined && now - enteringSince < IDLE_FORM_IN_FLIGHT_MS;
  const isDue =
    provider?.keepAwakeMode === 'governed' &&
    provider.awakeAdapter !== undefined &&
    state.sleepPermitted &&
    !isInFlight &&
    (state.deadline === undefined || Date.parse(state.deadline) <= now) &&
    awakeSince + state.idleTimeoutMinutes * MINUTE_MS <= now;
  const marked = isDue ? now : isInFlight ? enteringSince : undefined;
  await writeTick(context, {
    lastTickAt: now,
    awakeSince,
    ...(marked !== undefined && { enteringSince: marked }),
  });
  const recorded = isInFlight
    ? {
        ...state,
        diagnostics: [
          'an earlier idle-form call may still be running, so none is started',
          ...state.diagnostics,
        ].slice(0, DIAGNOSTIC_LIMIT),
      }
    : state;
  await writeGovernorState(awakeDirectory(context), recorded);

  return isDue
    ? { state: recorded, provider, enteringSince: now }
    : { state: recorded };
}

/**
 * recomputes and records the state under the caller's state lock, or, when
 * that fails, without the lock, noting why
 * @param context guest root, owners, account, clock and trust check
 * @param request the event and notes to record, and whether to prune
 * @param adapter an adapter call's result to record
 * @returns the recorded provider and state, and any event failure
 */
async function recordLocked(
  context: GovernorContext,
  request: RecomputeRequest,
  adapter?: AdapterResult,
): Promise<Recompute> {
  const recorded = await locked(context, async () =>
    recordState(context, request, adapter),
  );

  return 'value' in recorded
    ? recorded.value
    : recordUnlocked(
        context,
        { ...request, failure: recorded.failure },
        adapter,
      );
}

/**
 * recomputes the state and records it; the caller holds its state lock
 * @param context guest root, owners, account, clock and trust check
 * @param request the event and notes to record, and whether to prune
 * @param adapter an adapter call's result to record
 * @returns the recorded provider and state, and any event failure
 */
async function recordState(
  context: GovernorContext,
  request: RecomputeRequest,
  adapter?: AdapterResult,
): Promise<Recompute> {
  const computed = await recompute(context, request);
  const recorded = adapter ? { ...computed.state, adapter } : computed.state;
  await writeGovernorState(awakeDirectory(context), recorded);

  return { ...computed, state: recorded };
}

/**
 * records the state without the lock and without pruning, noting why; a
 * failed write of the record is not reported further
 * @param context guest root, owners, account, clock and trust check
 * @param unlocked the event and notes to record, and why the lock was not used
 * @param adapter an adapter call's result to record
 * @returns the recorded provider and state, and any event failure
 */
async function recordUnlocked(
  context: GovernorContext,
  unlocked: UnlockedRecord,
  adapter?: AdapterResult,
): Promise<Recompute> {
  const { failure, ...request } = unlocked;
  const computed = await recompute(context, {
    ...request,
    notes: [...(request.notes ?? []), failure],
    prune: false,
  });
  const recorded = adapter ? { ...computed.state, adapter } : computed.state;
  await writeGovernorState(awakeDirectory(context), recorded).catch(
    () => undefined,
  );

  return { ...computed, state: recorded };
}

/**
 * runs an action under the caller's state lock
 * @param context guest root and the caller's account
 * @param action work done under the lock
 * @returns the action's result, or why the lock or the action failed
 */
async function locked<T>(
  context: GovernorContext,
  action: () => Promise<T>,
): Promise<{ value: T } | { failure: string }> {
  return withAwakeLock(stateLock(context), action).then(
    (value) => ({ value }),
    (error: unknown) => ({
      failure: `the awake state could not be recorded under its lock: ${describe(error)}`,
    }),
  );
}
