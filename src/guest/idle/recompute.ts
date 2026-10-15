import {
  awakeDirectory,
  managedAwakeDirectory,
  ownAwakeDirectory,
} from './context.js';
import { computeDeadline, isHolderLive } from './deadline.js';
import { describe } from './dispatch.js';
import { pruneAbandonedTemporaries } from './files.js';
import {
  hashSession,
  holderFileName,
  readHolder,
  removeEntries,
  scanHolders,
  writeHolder,
} from './holders.js';
import { isLockFile } from './lock.js';
import { isSleepPermitted } from './permission.js';
import { isProcessGone } from './process-identity.js';
import { readSettings } from './settings.js';
import { readGovernorState } from './state-file.js';
import {
  GOVERNOR_STATE_FILE,
  DIAGNOSTIC_LIMIT,
  RECORDED_HOLD_LIMIT,
  recordableText,
} from './state.js';

import type { ProviderComponent } from '../../drivers/component-types.js';

import type { AwakeEvent } from './command.js';
import type { GovernorContext } from './context.js';
import type { AwakeDeadline, HolderActivity } from './deadline.js';
import type { HolderScan } from './holders.js';
import type { IdleOptions } from './options.js';
import type { Settings } from './settings.js';
import type { AdapterResult, GovernorState } from './state.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. A recompute reads the holders of both awake directories, the
// stored profile and the provider the host recorded, and derives the whole
// governor state from them. A caller that prunes holds its state lock and
// prunes only the directory it owns, so neither account removes what the
// other writes; a scan that could not see every holder fails closed

const MINUTE_MS = 60_000;

/** what one recompute records and whether it prunes */
export interface RecomputeRequest {
  /** the event to record first, if any */
  event?: AwakeEvent;
  /** notes to record with the state */
  notes?: readonly string[];
  /**
   * whether to prune the caller's own awake directory, which needs the
   * caller's state lock; a recompute that only reads, such as the one before
   * a deadline apply, never prunes
   */
  prune: boolean;
}

/** the inputs of one recompute and what it found */
export interface Recompute {
  /** the recorded provider, when the host recorded a valid one */
  provider?: ProviderComponent;
  /** the state the recompute recorded */
  state: GovernorState;
  /** why the event's holder was not written, which a later recompute repeats */
  eventFailure?: string;
}

/** what a recompute derives the state from */
interface StateInputs {
  /** current epoch milliseconds */
  now: number;
  /** the recorded provider and stored options */
  settings: Settings;
  /** the computed deadline */
  computed: AwakeDeadline;
  /** whether a scan missed holders, which never lets the workstation sleep */
  isFailedClosed: boolean;
  /** the adapter result the previous state recorded */
  adapter?: AdapterResult;
}

/**
 * records an event's holder, reads the holders of both awake directories,
 * prunes the invalid, the spent and the foreign entries of the caller's own
 * directory when asked, and computes the state
 * @param context guest root, owners, account, clock and trust check
 * @param request the event and notes to record, and whether to prune
 * @returns the recorded provider and the computed state
 */
export async function recompute(
  context: GovernorContext,
  request: RecomputeRequest,
): Promise<Recompute> {
  const { event, notes = [], prune } = request;
  const now = context.now();
  const settings = await readSettings(context.root);
  const { options, diagnostics } = settings;
  diagnostics.unshift(...notes);
  const eventFailure = event
    ? await recordedOrFailure(context, event, { now, options })
    : undefined;
  if (eventFailure !== undefined) {
    diagnostics.push(eventFailure);
  }
  const { shared, managed, isFailedClosed } = await scanBoth(
    context,
    diagnostics,
  );
  // a managed hold whose process has ended no longer holds anything
  const ended = await endedHolders(context, managed);
  managed.holders = managed.holders.filter(({ name }) => !ended.includes(name));
  const previous = await readGovernorState(
    awakeDirectory(context),
    context.owners,
  );
  const deadlineParams = { now, ...options };
  const computed = computeDeadline({
    ...deadlineParams,
    holders: [...shared.holders, ...managed.holders].map(
      ({ holder }) => holder,
    ),
    ...(previous.recorded &&
      previous.state.lastHeartbeat !== undefined && {
        recordedHeartbeat: Date.parse(previous.state.lastHeartbeat),
      }),
  });
  if (prune) {
    await pruneOwn(context, {
      scan: context.asRoot ? managed : shared,
      isSpent: (holder) => !isHolderLive(holder, deadlineParams),
      ended,
      now,
    });
  }
  const adapter = previous.recorded ? previous.state.adapter : undefined;

  return {
    ...(settings.provider && { provider: settings.provider }),
    state: stateOf({
      now,
      settings,
      computed,
      isFailedClosed,
      ...(adapter && { adapter }),
    }),
    ...(eventFailure !== undefined && { eventFailure }),
  };
}

/**
 * records an event's holder without letting a failure stop the recompute
 * @param context guest root, owners, account, clock and trust check
 * @param event the event to record
 * @param at the clock reading and the idle options applied
 * @param at.now current epoch milliseconds
 * @param at.options the idle options applied
 * @returns why the event was not recorded, or nothing once it was
 */
async function recordedOrFailure(
  context: GovernorContext,
  event: AwakeEvent,
  at: { now: number; options: IdleOptions },
): Promise<string | undefined> {
  return recordEvent(context, event, at).then(
    () => undefined,
    (error: unknown) =>
      `the ${event.action} event was not recorded, which counts as idleness: ${describe(error)}`,
  );
}

/**
 * scans both awake directories, noting in the diagnostics every scan that
 * could not see all its holders and every invalid holder file it found
 * @param context guest root and the owners each directory accepts
 * @param diagnostics the recompute's diagnostics, to which the notes are added
 * @returns both scans, and whether either was incomplete, which fails closed
 */
async function scanBoth(
  context: GovernorContext,
  diagnostics: string[],
): Promise<{
  shared: HolderScan;
  managed: HolderScan;
  isFailedClosed: boolean;
}> {
  const shared = await scanHolders(awakeDirectory(context), context.owners);
  const managed = await scanHolders(
    managedAwakeDirectory(context),
    context.managedOwners,
  );
  const scans = [
    { scan: shared, label: 'shared' },
    { scan: managed, label: 'managed' },
  ];
  for (const { scan, label } of scans) {
    if (scan.incomplete !== undefined) {
      diagnostics.push(
        `the ${label} awake directory scan is incomplete, so sleep is not permitted: ${scan.incomplete}`,
      );
    }
    if (scan.refused.length > 0) {
      diagnostics.push(
        `ignored ${scan.refused.length} invalid holder file(s) in the ${label} awake directory`,
      );
    }
  }

  return {
    shared,
    managed,
    isFailedClosed: scans.some(({ scan }) => scan.incomplete !== undefined),
  };
}

/**
 * finds the managed holds whose process has ended, by process id and start
 * time, so a crashed managed operation's hold stops keeping the workstation
 * awake at once instead of at the hold maximum
 * @param context the process table's location
 * @param managed the scan of the managed awake directory
 * @returns names of the holder files whose recorded process is gone
 */
async function endedHolders(
  context: GovernorContext,
  managed: HolderScan,
): Promise<string[]> {
  const ended: string[] = [];
  for (const { name, holder } of managed.holders) {
    if (
      holder.process !== undefined &&
      (await isProcessGone(holder.process, context.procRoot))
    ) {
      ended.push(name);
    }
  }

  return ended;
}

/**
 * prunes the caller's own awake directory: its invalid and spent holder
 * files, its abandoned temporaries and every entry that is neither a holder
 * nor one of the governor's own files
 * @param context guest root and the caller's account
 * @param pruning the scan of the caller's own directory, the spent test and the current time
 * @param pruning.scan the scan of the caller's own directory
 * @param pruning.isSpent tells whether a holder no longer counts
 * @param pruning.ended names of managed holds whose process has ended
 * @param pruning.now current epoch milliseconds
 */
async function pruneOwn(
  context: GovernorContext,
  pruning: {
    scan: HolderScan;
    isSpent: (holder: HolderActivity) => boolean;
    ended: readonly string[];
    now: number;
  },
): Promise<void> {
  const { scan, isSpent, ended, now } = pruning;
  const directory = ownAwakeDirectory(context);
  await removeEntries(directory, [
    ...scan.refused,
    ...scan.holders
      .filter(({ holder }) => isSpent(holder))
      .map(({ name }) => name),
    ...ended,
    ...scan.others.filter(
      (name) => name !== GOVERNOR_STATE_FILE && !isLockFile(name),
    ),
  ]);
  await pruneAbandonedTemporaries(directory, scan.temporaries, now);
}

/**
 * derives the bounded governor state from a recompute's inputs
 * @param inputs current time, settings, computed deadline and previous adapter result
 * @returns the state to record
 */
function stateOf(inputs: StateInputs): GovernorState {
  const { now, settings, computed, isFailedClosed, adapter } = inputs;
  const { provider, options, diagnostics } = settings;
  const isPermitted =
    !isFailedClosed &&
    provider !== undefined &&
    isSleepPermitted({
      ...provider,
      idleTimeoutMinutes: options.idleTimeoutMinutes,
    });

  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    ...(provider && { keepAwakeMode: provider.keepAwakeMode }),
    idleTimeoutMinutes: options.idleTimeoutMinutes,
    holdMaxMinutes: options.holdMaxMinutes,
    ...(computed.lastHeartbeat !== undefined && {
      lastHeartbeat: new Date(computed.lastHeartbeat).toISOString(),
    }),
    holds: computed.holds
      .slice(0, RECORDED_HOLD_LIMIT)
      .map(({ source, session, expiresAt }) => ({
        source,
        session,
        expiresAt: new Date(expiresAt).toISOString(),
      })),
    openHolds: computed.holds.length,
    ...(computed.deadline !== undefined && {
      deadline: new Date(computed.deadline).toISOString(),
    }),
    sleepPermitted: isPermitted,
    ...(adapter && { adapter }),
    diagnostics: diagnostics.slice(0, DIAGNOSTIC_LIMIT).map(recordableText),
  };
}

/**
 * writes the event's holder: every event is a heartbeat; `hold-open` opens or
 * refreshes the hold, a heartbeat refreshes a hold still open, and
 * `hold-close` closes it
 * @param context guest root, owners and the caller's account
 * @param event the validated event
 * @param at the current time and the idle options
 * @param at.now current epoch milliseconds
 * @param at.options the idle options
 */
async function recordEvent(
  context: GovernorContext,
  event: AwakeEvent,
  at: { now: number; options: IdleOptions },
): Promise<void> {
  const { now, options } = at;
  const directory = ownAwakeDirectory(context);
  const session = hashSession(event.session);
  const existing = await readHolder(
    directory,
    holderFileName(event.source, session),
    context.asRoot ? context.managedOwners : context.owners,
  );
  const isOpen =
    existing?.holdExpiresAt !== undefined && existing.holdExpiresAt > now;
  const keepsHold =
    event.action === 'hold-open' || (event.action === 'heartbeat' && isOpen);
  const holder: HolderActivity = {
    source: event.source,
    session,
    lastHeartbeat: now,
    ...(keepsHold && {
      holdExpiresAt: now + options.holdMaxMinutes * MINUTE_MS,
      // only a managed hold names its process; an agent hook's hold has none
      // and is bound by the hold maximum alone
      ...(context.asRoot && event.process && { process: event.process }),
    }),
  };
  await writeHolder(directory, holder);
}
