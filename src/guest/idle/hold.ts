import { productionContext } from './context.js';
import { handleAwakeEvent } from './governor.js';
import { hashSession } from './holders.js';
import { SESSION_ID, SOURCE_NAME } from './names.js';
import { DEFAULT_HOLD_MAX_MINUTES } from './options.js';
import { identifyProcess } from './process-identity.js';

import type { GovernorContext } from './context.js';
import type { GovernorState } from './state.js';

// guest kernel: imports only other guest code, and names no provider

const MINUTE_MS = 60_000;

/** shortest time between two refreshes of a managed hold */
const HOLD_REFRESH_FLOOR_MS = 15_000;

/** the holder a managed operation keeps awake through */
export interface AwakeHolder {
  /** managed operation, as `--source` names it, such as `updater` */
  source: string;
  /** identifier of this run, as `--session` takes it */
  session: string;
}

/** a hold event the managed hold reports */
type HoldEvent = AwakeHolder & {
  /** whether the hold opens, is refreshed, or closes */
  action: 'hold-open' | 'hold-close';
};

/**
 * keeps the workstation awake for a managed operation (REQ-IDLE-7): it opens a
 * hold, refreshes it every half hold maximum while the operation runs, so the
 * hold never lapses mid-operation, and closes it in a `finally`. Run as root,
 * the hold is recorded in the managed awake directory the agent account can
 * neither remove nor block. The hold never fails the operation: a failed open,
 * refresh or close counts as idleness and is recorded by the governor, and the
 * operation's own outcome passes through
 * @param holder the operation's source and run identifier
 * @param operation the managed work to protect
 * @param context the governor context; the deployed one by default
 * @returns the operation's result
 * @throws {Error} before the operation runs when the source or session is not
 * one the awake command accepts, which is a defect of the caller
 */
export async function withAwakeHold<T>(
  holder: AwakeHolder,
  operation: () => Promise<T>,
  context?: GovernorContext,
): Promise<T> {
  if (!SOURCE_NAME.test(holder.source) || !SESSION_ID.test(holder.session)) {
    throw new Error(
      'An awake hold needs a source and session the awake command accepts',
    );
  }
  const governor = await (
    context ? Promise.resolve(context) : productionContext()
  ).catch(() => undefined);
  // a managed hold names this process, so it ends with the process
  const holderProcess = governor?.asRoot
    ? await identifyProcess(process.pid, governor.procRoot)
    : undefined;
  const open = {
    ...holder,
    action: 'hold-open' as const,
    ...(holderProcess && { process: holderProcess }),
  };
  const opened = await report(governor, open);
  const holdMaxMinutes = opened?.holdMaxMinutes ?? DEFAULT_HOLD_MAX_MINUTES;
  const isHeld = (state: GovernorState | undefined): boolean =>
    state?.holds.some(
      ({ source, session }) =>
        source === holder.source && session === hashSession(holder.session),
    ) === true;
  let refreshing: Promise<unknown> | undefined;
  let retrier: ReturnType<typeof setInterval> | undefined;
  const refresh = (): void => {
    // a refresh still running when the next is due covers it
    refreshing ??= report(governor, open)
      .then((state) => {
        if (isHeld(state)) {
          clearInterval(retrier);
        }
      })
      .finally(() => {
        refreshing = undefined;
      });
  };
  const refresher = setInterval(
    refresh,
    Math.max((holdMaxMinutes * MINUTE_MS) / 2, HOLD_REFRESH_FLOOR_MS),
  );
  // the refresh never keeps the process alive after the operation
  refresher.unref();
  if (!isHeld(opened)) {
    // the governor could not record the open: the first transaction on a new
    // workstation starts before the directories the governor writes exist, and
    // waiting a whole refresh would leave the long first install unheld, so
    // the open is retried at the shortest interval until it is recorded
    retrier = setInterval(refresh, HOLD_REFRESH_FLOOR_MS);
    retrier.unref();
  }
  try {
    return await operation();
  } finally {
    clearInterval(refresher);
    clearInterval(retrier);
    await refreshing;
    await report(governor, { ...holder, action: 'hold-close' });
  }
}

/**
 * records one hold event, swallowing any failure
 * @param context the governor context, absent when it could not be built
 * @param event the hold event
 * @returns the recorded state, or undefined when nothing was recorded
 */
async function report(
  context: GovernorContext | undefined,
  event: HoldEvent,
): Promise<GovernorState | undefined> {
  return context
    ? handleAwakeEvent(context, event).catch(() => undefined)
    : undefined;
}
