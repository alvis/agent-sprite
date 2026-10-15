import { join } from 'node:path';

import { isRecord } from '../records.js';

import { readUntrustedJson, writeAtomically } from './files.js';
import { RUN_DIRECTORY } from './state.js';

import type { GovernorContext } from './context.js';
import type { MachineClock } from './machine-clock.js';

// guest kernel: imports only Node built-ins and other guest code. Only the
// root tick writes the tick record, in the root-only run directory, and a
// reader accepts it only from its own account

/**
 * ticks further apart than this mean the workstation slept or the ticker
 * stopped, so the governor grants a full idle timeout again before sleeping;
 * a ticker calls `tick` more often than this
 */
const TICK_RESUME_GAP_MS = 180_000;

/**
 * how much further the wall clock may move than the guest's own uptime between
 * two ticks before the guest counts as frozen and resumed in between
 */
const RESUME_SKEW_MS = 10_000;

const TICK_FILE = 'idle-tick.json';
const TICK_MAX_BYTES = 512;

/** when the last tick ran, since when the workstation counts as awake, and any idle-form call in flight */
export interface TickRecord {
  /** epoch milliseconds of the last tick */
  lastTickAt: number;
  /**
   * epoch milliseconds the idle grace started; absent after the workstation
   * entered an idle form, so the first tick after it resumes starts the grace
   */
  awakeSince?: number;
  /** epoch milliseconds an idle-form call started that has not settled */
  enteringSince?: number;
  /** the kernel's boot id when the record was written */
  bootId?: string;
  /** the guest's uptime in milliseconds when the record was written */
  uptimeMs?: number;
}

/** the tick record as the next tick reads it */
export interface TickState {
  /** epoch milliseconds the workstation counts as awake since */
  awakeSince: number;
  /** epoch milliseconds an idle-form call started that has not settled */
  enteringSince?: number;
}

/**
 * reads the tick record, restarting the idle grace and dropping any call in
 * flight when there is no valid record, the last tick is too long ago, an idle
 * form was entered since, the machine booted since, or it was frozen and
 * resumed since: the wall clock moved further than the guest's uptime
 * @param context guest root and boot clock
 * @param now current epoch milliseconds
 * @returns since when the workstation counts as awake, and any call in flight
 */
export async function readTick(
  context: Pick<GovernorContext, 'root' | 'machineClock'>,
  now: number,
): Promise<TickState> {
  const uid = process.getuid?.();
  const read = await readUntrustedJson(
    join(context.root, RUN_DIRECTORY, TICK_FILE),
    {
      owners: new Set(uid === undefined ? [] : [uid]),
      maxBytes: TICK_MAX_BYTES,
    },
  );
  const record = 'value' in read && isRecord(read.value) ? read.value : {};
  const { lastTickAt, awakeSince, enteringSince } = record;
  const machine = await context.machineClock?.();
  const isContinuous = machine === undefined || isSameRun(record, machine, now);
  const isGraceKept =
    isContinuous &&
    isPast(lastTickAt, now) &&
    now - lastTickAt <= TICK_RESUME_GAP_MS &&
    isPast(awakeSince, now);

  return {
    awakeSince: isGraceKept ? awakeSince : now,
    ...(isContinuous && isPast(enteringSince, now) && { enteringSince }),
  };
}

/**
 * tells whether the machine kept running between the record and now: the same
 * boot, and no freeze in which the wall clock advanced and the uptime did not
 * @param record untrusted decoded tick record
 * @param machine the boot id and uptime now
 * @param now current epoch milliseconds
 * @returns false for a record of another boot, an unusable stamp or a resume
 */
function isSameRun(
  record: Record<string, unknown>,
  machine: MachineClock,
  now: number,
): boolean {
  const { bootId, uptimeMs, lastTickAt } = record;
  if (
    bootId !== machine.bootId ||
    typeof uptimeMs !== 'number' ||
    !Number.isFinite(uptimeMs) ||
    !isPast(lastTickAt, now)
  ) {
    return false;
  }
  const ran = machine.uptimeMs - uptimeMs;

  return ran >= 0 && now - lastTickAt - ran <= RESUME_SKEW_MS;
}

/**
 * records the tick in the root-only run directory
 * @param context guest root and boot clock
 * @param record the tick time, since when the workstation counts as awake,
 * and any idle-form call in flight; the boot id and uptime are added here
 */
export async function writeTick(
  context: Pick<GovernorContext, 'root' | 'machineClock'>,
  record: TickRecord,
): Promise<void> {
  const machine = await context.machineClock?.();
  await writeAtomically(
    join(context.root, RUN_DIRECTORY),
    TICK_FILE,
    `${JSON.stringify({
      ...record,
      ...(machine && { bootId: machine.bootId, uptimeMs: machine.uptimeMs }),
    })}\n`,
  );
}

/**
 * validates an epoch-milliseconds field that may not lie in the future
 * @param value untrusted field
 * @param now current epoch milliseconds
 * @returns whether the value is a number no later than now
 */
function isPast(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value <= now;
}
