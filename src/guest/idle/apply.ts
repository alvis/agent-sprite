import { pathToFileURL } from 'node:url';

import { applyLock, productionContext, rootOfModule } from './context.js';
import {
  ADAPTER_CALL_LIMIT_MS,
  APPLY_DEADLINE_LIMIT_MS,
  APPLY_LOCK_STALE_MS,
  APPLY_LOCK_WAIT_MS,
  TERMINATE_GRACE_MS,
  applyDeadline,
  describe,
} from './dispatch.js';
import { withAwakeLock } from './lock.js';
import { recompute } from './recompute.js';

import type { GovernorContext } from './context.js';
import type { AdapterResult } from './state.js';

/** latest moment into an apply at which a further adapter call still fits in the dispatch limit */
const RETRY_START_LIMIT_MS =
  APPLY_DEADLINE_LIMIT_MS - TERMINATE_GRACE_MS - ADAPTER_CALL_LIMIT_MS;

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. Applies the latest deadline to a `native-deadline` adapter as the
// agent account. Its entry is the child a root caller starts with the agent
// account's user and group: it takes no arguments and no input, finds the
// guest root from its own location, refuses to run as root, and prints only
// the result

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const context = await productionContext(rootOfModule(import.meta.url));
  // the caller ends a slow apply with SIGTERM first: the apply then gives up
  // its lock before the process ends, instead of leaving it for a later apply
  const terminated = new AbortController();
  process.once('SIGTERM', () => {
    terminated.abort();
  });
  const result: AdapterResult = context.asRoot
    ? {
        at: new Date(context.now()).toISOString(),
        action: 'apply-deadline',
        failure: 'a native-deadline adapter never runs as root',
      }
    : await applyLatestDeadline(context, terminated.signal);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // an adapter may leave sockets or timers open; the apply is complete
  process.exit(0);
}

/**
 * recomputes the deadline from every holder just before applying it, under
 * the apply lock, so applies run one at a time and each hands over the
 * latest deadline, never an older one computed before a newer event; the
 * caller runs as the agent account. The lock is held until the adapter call
 * has settled or the caller ends the apply, and is waited for only briefly, so
 * the whole apply fits inside the dispatch limit
 * @param context guest root, owners, clock and trust check
 * @param terminate aborted when the caller ends the apply early
 * @returns the adapter call's result
 */
export async function applyLatestDeadline(
  context: GovernorContext,
  terminate?: AbortSignal,
): Promise<AdapterResult> {
  const at = new Date(context.now()).toISOString();
  const terminatedResult: AdapterResult = {
    at,
    action: 'apply-deadline',
    failure: 'the apply was ended before the adapter answered',
  };
  try {
    return await withAwakeLock(
      applyLock(context),
      async () => {
        if (terminate?.aborted) {
          return terminatedResult;
        }
        const started = performance.now();
        let outcome = await applyOnce(context, terminate, terminatedResult);
        // an event that could not take the lock while this apply ran has
        // already recorded its holder change: apply that latest deadline now,
        // when the time left allows another adapter call, instead of leaving
        // the provider on the older one
        while (
          outcome.result !== undefined &&
          !terminate?.aborted &&
          performance.now() - started <= RETRY_START_LIMIT_MS &&
          (await deadlineOf(context)) !== outcome.deadline
        ) {
          outcome = await applyOnce(context, terminate, terminatedResult);
        }

        return outcome.adapter;
      },
      { waitMs: APPLY_LOCK_WAIT_MS, staleMs: APPLY_LOCK_STALE_MS },
    );
  } catch (error) {
    return { at, action: 'apply-deadline', failure: describe(error) };
  }
}

/**
 * settles with a result when a signal aborts
 * @param signal the signal to watch
 * @param result what to settle with
 * @returns a promise that stays pending while the signal is not aborted
 */
async function endedBy(
  signal: AbortSignal,
  result: AdapterResult,
): Promise<AdapterResult> {
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve(result);
      },
      { once: true },
    );
  });
}

/** one adapter call and the deadline it was handed */
interface AppliedDeadline {
  /** the call's recorded result */
  adapter: AdapterResult;
  /** the deadline handed over; null when there was none */
  deadline: string | null;
  /** the success text, absent after a failure */
  result?: string;
}

/**
 * recomputes the deadline and hands it to the adapter, under the apply lock
 * @param context guest root, owners, clock and trust check
 * @param terminate aborted when the caller ends the apply early
 * @param terminatedResult what to record when the caller ends the apply
 * @returns the adapter call's result and the deadline it was handed
 */
async function applyOnce(
  context: GovernorContext,
  terminate: AbortSignal | undefined,
  terminatedResult: AdapterResult,
): Promise<AppliedDeadline> {
  const at = new Date(context.now()).toISOString();
  const { provider, state } = await recompute(context, { prune: false });
  const deadline = state.deadline ?? null;
  if (provider?.keepAwakeMode !== 'native-deadline') {
    return {
      adapter: {
        at,
        action: 'apply-deadline',
        failure: 'the recorded provider does not apply deadlines',
      },
      deadline,
    };
  }

  // no deadline releases the keep-awake claim with the current time
  const applying = applyDeadline(
    context,
    provider,
    new Date(state.deadline ?? state.updatedAt),
  );
  const adapter = terminate
    ? await Promise.race([applying, endedBy(terminate, terminatedResult)])
    : await applying;

  return { adapter, deadline, result: adapter.result };
}

/**
 * reads the deadline the holders now give
 * @param context guest root, owners, clock and trust check
 * @returns the deadline as an ISO 8601 instant, or null when there is none
 */
async function deadlineOf(context: GovernorContext): Promise<string | null> {
  const { state } = await recompute(context, { prune: false });

  return state.deadline ?? null;
}
