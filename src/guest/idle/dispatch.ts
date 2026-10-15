import { isRecord } from '../records.js';

import { loadAwakeAdapter } from './adapter.js';
import { recordableText } from './state.js';

import type { ProviderComponent } from '../../drivers/component-types.js';

import type { AdapterSource } from './adapter.js';
import type { AdapterResult } from './state.js';

// guest kernel: imports only other guest code, and names no provider. Each
// adapter call is bounded and settles into a recorded result, so a failing or
// hanging provider adapter never fails an awake event or a tick. A call the
// limit outlasts is not cancelled; the caller keeps it from being repeated
// while it may still run

/**
 * longest an awake event waits on a whole deadline apply, which is the
 * dispatch limit: a root caller ends the agent-account child here
 */
export const APPLY_DEADLINE_LIMIT_MS = 2_500;

/**
 * longest the apply waits for the apply lock; with the adapter call below and
 * the child's start-up, the apply finishes well inside the dispatch limit
 */
export const APPLY_LOCK_WAIT_MS = 400;

/** age after which an apply lock counts as left by a killed apply */
export const APPLY_LOCK_STALE_MS = 5_000;

/**
 * how long before the dispatch limit a root caller asks the agent-account
 * child to stop, so the child can give up the apply lock before it is killed
 */
export const TERMINATE_GRACE_MS = 300;

/** the result recorded when the apply released the keep-awake claim */
export const RELEASED = 'released';

/** longest the adapter's `applyAwakeDeadline` runs inside an apply */
export const ADAPTER_CALL_LIMIT_MS = 1_400;

/** longest a tick waits on `enterIdleForm` */
export const ENTER_IDLE_FORM_LIMIT_MS = 60_000;

/** what an adapter call needs: the guest root, the trust check and the clock */
export type AdapterCall = Pick<AdapterSource, 'root' | 'trust'> & {
  /** current epoch milliseconds */
  now: () => number;
};

/**
 * hands a deadline to a `native-deadline` adapter within its time limit; the
 * caller runs as the agent account, never as root
 * @param context guest root, clock and trust check
 * @param provider the recorded provider
 * @param deadline the deadline to apply; the current time releases the claim
 * @returns the adapter call's result
 */
export async function applyDeadline(
  context: AdapterCall,
  provider: ProviderComponent,
  deadline: Date,
): Promise<AdapterResult> {
  const at = new Date(context.now()).toISOString();
  try {
    // a root caller hands the apply to the agent account instead
    if (process.getuid?.() === 0) {
      throw new Error('a native-deadline adapter never runs as root');
    }
    const loaded = await loadAwakeAdapter({ ...context, provider });
    if (loaded.mode !== 'native-deadline') {
      throw new Error('the adapter does not apply deadlines');
    }
    await withinLimit(
      loaded.adapter.applyAwakeDeadline(deadline),
      ADAPTER_CALL_LIMIT_MS,
    );

    // a deadline that is not ahead removes the keep-awake claim: recorded as
    // a release, not as a deadline that was set
    return {
      at,
      action: 'apply-deadline',
      result:
        deadline.getTime() <= context.now() ? RELEASED : deadline.toISOString(),
    };
  } catch (error) {
    return { at, action: 'apply-deadline', failure: describe(error) };
  }
}

/** an idle-form call's recorded result and whether it may still be running */
export interface IdleFormOutcome {
  /** the result to record */
  adapter: AdapterResult;
  /** true when the time limit ended the wait, so the call may still be running */
  isInFlight: boolean;
}

/** what an adapter's idle-form call settled to; absent when it ran out of time */
type IdleFormSettlement = { outcome: unknown } | { error: unknown } | undefined;

/**
 * calls the adapter's idle form within the time limit
 * @param adapter the loaded module of a provider that enters idle forms
 * @param adapter.enterIdleForm asks the provider to enter its first idle form
 * @returns what the call settled to, or nothing when it did not finish in time
 */
async function callIdleForm(adapter: {
  enterIdleForm: () => Promise<unknown>;
}): Promise<IdleFormSettlement> {
  const call = Promise.resolve()
    .then(async () => adapter.enterIdleForm())
    .then(
      (outcome: unknown) => ({ outcome }),
      (error: unknown) => ({ error }),
    );

  return withinLimit(call, ENTER_IDLE_FORM_LIMIT_MS).catch(() => undefined);
}

/**
 * asks a `governed` adapter to enter its first available idle form within its
 * time limit; the caller runs as root
 * @param context guest root, clock and trust check
 * @param provider the recorded provider
 * @returns the adapter call's result, and whether it may still be running
 */
export async function enterIdleForm(
  context: AdapterCall,
  provider: ProviderComponent,
): Promise<IdleFormOutcome> {
  const at = new Date(context.now()).toISOString();
  const failed = (failure: string, isInFlight = false): IdleFormOutcome => ({
    adapter: {
      at,
      action: 'enter-idle-form',
      failure: recordableText(failure),
    },
    isInFlight,
  });
  // a deadline adapter is never imported by the root caller of a tick
  if (provider.keepAwakeMode !== 'governed') {
    return failed('the adapter does not enter idle forms');
  }
  const loading = await loadAwakeAdapter({ ...context, provider }).then(
    (loaded) => ({ loaded }),
    (error: unknown) => ({ error }),
  );
  if ('error' in loading) {
    return failed(describe(loading.error));
  }
  const { loaded } = loading;
  if (loaded.mode !== 'governed') {
    return failed('the adapter does not enter idle forms');
  }
  const settled = await callIdleForm(loaded.adapter);
  if (!settled) {
    return failed(
      `the adapter did not finish within ${ENTER_IDLE_FORM_LIMIT_MS} ms`,
      true,
    );
  }
  if ('error' in settled) {
    return failed(describe(settled.error));
  }

  return (
    resultOfOutcome(settled.outcome, at) ?? failed(failureOf(settled.outcome))
  );
}

/**
 * turns what the adapter answered into the result to record, when it entered
 * an idle form or could not tell; the outcome comes from provider code loaded
 * at run time
 * @param outcome the adapter's answer
 * @param at ISO 8601 instant of the call
 * @returns the recorded result, or nothing when the answer is a failure
 */
function resultOfOutcome(
  outcome: unknown,
  at: string,
): IdleFormOutcome | undefined {
  if (isRecord(outcome) && typeof outcome.entered === 'string') {
    return {
      adapter: {
        at,
        action: 'enter-idle-form',
        result: recordableText(outcome.entered),
      },
      isInFlight: false,
    };
  }
  if (isRecord(outcome) && typeof outcome.unknown === 'string') {
    // the call may have frozen the machine, so this is not a failure to show
    return {
      adapter: {
        at,
        action: 'enter-idle-form',
        result: recordableText(`unknown: ${outcome.unknown}`),
      },
      isInFlight: false,
    };
  }

  return undefined;
}

/**
 * names why an adapter's answer entered no idle form
 * @param outcome the adapter's answer
 * @returns its failure, or that it returned no idle form
 */
function failureOf(outcome: unknown): string {
  return isRecord(outcome) && typeof outcome.failure === 'string'
    ? outcome.failure
    : 'the adapter returned no idle form';
}

/**
 * turns a failure into a bounded non-secret note
 * @param error caught failure
 * @returns its message, cut to the diagnostic length
 */
export function describe(error: unknown): string {
  const message =
    isRecord(error) && typeof error.message === 'string'
      ? error.message
      : 'unknown failure';

  return recordableText(message);
}

/**
 * bounds an adapter call
 * @param work the pending call
 * @param limitMs longest wait
 * @returns the call's result
 * @throws {Error} when the call outlasts the limit
 */
async function withinLimit<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the adapter did not finish within ${limitMs} ms`));
    }, limitMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}
