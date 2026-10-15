import type { HolderProcess } from './process-identity.js';

// guest kernel: pure arithmetic, names no provider

const MINUTE_MS = 60_000;

/**
 * how far into the future a holder's heartbeat may lie and still count, which
 * covers clock skew between writers; a later one is forged or broken
 */
const HEARTBEAT_SKEW_MS = 60_000;

/** what one holder last reported, as recorded in its holder file */
export interface HolderActivity {
  /** harness or managed operation that reported */
  source: string;
  /** SHA-256 of the session identifier, in hexadecimal */
  session: string;
  /** epoch milliseconds of the holder's last awake event */
  lastHeartbeat: number;
  /** epoch milliseconds the holder's open hold expires; absent when no hold is open */
  holdExpiresAt?: number;
  /** the process a managed hold belongs to; absent for an agent hook's hold */
  process?: HolderProcess;
}

/** a hold that still keeps the workstation awake */
export interface OpenHold {
  /** harness or managed operation that opened it */
  source: string;
  /** SHA-256 of the session identifier, in hexadecimal */
  session: string;
  /** epoch milliseconds the hold expires unless refreshed */
  expiresAt: number;
}

/** the inputs of one deadline computation */
export interface DeadlineParams {
  /** every valid holder */
  holders: readonly HolderActivity[];
  /** last heartbeat the governor recorded before, kept after its holder was pruned */
  recordedHeartbeat?: number;
  /** current epoch milliseconds */
  now: number;
  /** minutes without heartbeat or hold before sleep; 0 lets only holds count */
  idleTimeoutMinutes: number;
  /** minutes a hold lasts after its last refresh */
  holdMaxMinutes: number;
}

/** the awake deadline and what it was computed from */
export interface AwakeDeadline {
  /** epoch milliseconds of the latest heartbeat across holders; absent before the first */
  lastHeartbeat?: number;
  /** holds still open, latest expiry first */
  holds: OpenHold[];
  /** epoch milliseconds the workstation stays awake until; absent when nothing keeps it awake */
  deadline?: number;
}

/**
 * computes the one awake deadline: the later of (last heartbeat + idle
 * timeout) and the latest open-hold expiry. A holder whose heartbeat lies more
 * than HEARTBEAT_SKEW_MS in the future, written by a forged file or a broken
 * clock, counts for nothing; a heartbeat within that skew counts as now, and a
 * hold expiry is capped at now plus the hold maximum, so no holder outlasts
 * the maximum
 * @param params holders, the current time and the idle options
 * @returns the deadline with the heartbeat and holds it came from
 */
export function computeDeadline(params: DeadlineParams): AwakeDeadline {
  const { recordedHeartbeat, now, idleTimeoutMinutes } = params;
  const holders = params.holders.filter((holder) => isCredible(holder, now));
  const holdLimit = now + params.holdMaxMinutes * MINUTE_MS;
  const heartbeats = [
    ...holders.map(({ lastHeartbeat }) => lastHeartbeat),
    ...(recordedHeartbeat === undefined ||
    recordedHeartbeat > now + HEARTBEAT_SKEW_MS
      ? []
      : [recordedHeartbeat]),
  ].map((heartbeat) => Math.min(heartbeat, now));
  const lastHeartbeat = heartbeats.length ? Math.max(...heartbeats) : undefined;
  const holds = holders
    .flatMap(({ source, session, holdExpiresAt }) =>
      holdExpiresAt === undefined
        ? []
        : [{ source, session, expiresAt: Math.min(holdExpiresAt, holdLimit) }],
    )
    .filter(({ expiresAt }) => expiresAt > now)
    .sort((left, right) => right.expiresAt - left.expiresAt);
  const contributions = [
    ...(idleTimeoutMinutes > 0 && lastHeartbeat !== undefined
      ? [lastHeartbeat + idleTimeoutMinutes * MINUTE_MS]
      : []),
    ...holds.map(({ expiresAt }) => expiresAt),
  ];

  return {
    ...(lastHeartbeat !== undefined && { lastHeartbeat }),
    holds,
    ...(contributions.length > 0 && {
      deadline: Math.max(...contributions),
    }),
  };
}

/**
 * tells whether a holder's heartbeat lies within the tolerated skew of now
 * @param holder the holder's recorded activity
 * @param now current epoch milliseconds
 * @returns false for a heartbeat further in the future than the skew
 */
function isCredible(holder: HolderActivity, now: number): boolean {
  return holder.lastHeartbeat <= now + HEARTBEAT_SKEW_MS;
}

/**
 * tells whether a holder still contributes to the deadline, so a holder that
 * no longer does, or whose heartbeat is not credible, can be pruned
 * @param holder the holder's recorded activity
 * @param params the current time and the idle options
 * @param params.now current epoch milliseconds
 * @param params.idleTimeoutMinutes minutes without heartbeat or hold before sleep
 * @param params.holdMaxMinutes minutes a hold lasts after its last refresh
 * @returns true while its heartbeat or its hold still keeps the workstation awake
 */
export function isHolderLive(
  holder: HolderActivity,
  params: Omit<DeadlineParams, 'holders' | 'recordedHeartbeat'>,
): boolean {
  const { holds, deadline } = computeDeadline({ ...params, holders: [holder] });

  return holds.length > 0 || (deadline !== undefined && deadline > params.now);
}
