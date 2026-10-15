import { isRecord, isStringArray } from '../records.js';

import { SESSION_HASH, SOURCE_NAME } from './names.js';
import { isKeepAwakeMode } from './provider-facts.js';

// guest kernel: constants, types and validators only, with no I/O, so the host
// imports them to install the governor's directories and to validate its
// report. The governor records its state after every recompute; the host
// reads it back through a root report that validates it again, so the record
// is data to every reader and its shape is checked field by field

/** the run directory, relative to the guest root, which only root writes */
export const RUN_DIRECTORY = 'run';

/**
 * the shared awake directory, relative to the guest root: the agent account's
 * holders, the state record and the agent account's locks
 */
export const AWAKE_DIRECTORY = 'run/awake';

/**
 * the managed awake directory, relative to the guest root: the holders of
 * root's managed operations and root's lock, which the agent account reads but
 * can neither remove nor block
 */
export const MANAGED_AWAKE_DIRECTORY = 'run/awake-root';

/** the governor state record within the awake directory */
export const GOVERNOR_STATE_FILE = 'governor.json';

/** largest governor state record a reader accepts, in bytes */
export const STATE_MAX_BYTES = 16_384;
/** most holds the record lists */
export const RECORDED_HOLD_LIMIT = 32;
/** most diagnostics the record keeps */
export const DIAGNOSTIC_LIMIT = 8;
/** longest diagnostic the record keeps */
const DIAGNOSTIC_LENGTH = 240;

/** a C0 or C1 control character, which could rewrite a terminal's display */
const CONTROL_CHARACTER = /\p{Cc}/u;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/** longest ISO 8601 instant a record holds */
const INSTANT_LENGTH = 32;
const ADAPTER_ACTIONS: readonly unknown[] = [
  'apply-deadline',
  'enter-idle-form',
];

/** a hold the governor recorded as open */
export interface RecordedHold {
  /** harness or managed operation that opened it */
  source: string;
  /** SHA-256 of the session identifier, in hexadecimal */
  session: string;
  /** ISO 8601 instant the hold expires unless refreshed */
  expiresAt: string;
}

/** the last call the governor made to the provider's awake adapter */
export interface AdapterResult {
  /** ISO 8601 instant of the call */
  at: string;
  /** what the governor asked the adapter to do */
  action: 'apply-deadline' | 'enter-idle-form';
  /** the deadline applied, or the idle form entered; absent after a failure */
  result?: string;
  /** non-secret reason the call failed; absent after a success */
  failure?: string;
}

/** the idle governor's state after its last recompute */
export interface GovernorState {
  /** record format */
  version: 1;
  /** ISO 8601 instant of the recompute */
  updatedAt: string;
  /** the provider's keep-awake mode; absent before the host records a provider */
  keepAwakeMode?: 'native-deadline' | 'governed' | 'none';
  /** minutes without heartbeat or hold before sleep, as applied */
  idleTimeoutMinutes: number;
  /** minutes a hold lasts after its last refresh, as applied */
  holdMaxMinutes: number;
  /** ISO 8601 instant of the latest heartbeat; absent before the first */
  lastHeartbeat?: string;
  /** holds still open, latest expiry first */
  holds: RecordedHold[];
  /** total open holds, including any beyond the listed ones */
  openHolds: number;
  /** ISO 8601 instant the workstation stays awake until; absent when nothing keeps it awake */
  deadline?: string;
  /** whether the governor may initiate sleep under REQ-IDLE-9 */
  sleepPermitted: boolean;
  /** the last awake adapter call, kept across recomputes that make none */
  adapter?: AdapterResult;
  /** non-secret notes from the last recompute */
  diagnostics: string[];
}

/** the governor state as the root report hands it to the host */
export type GovernorReport =
  | {
      /** the record exists and is valid */
      recorded: true;
      /** the validated record */
      state: GovernorState;
    }
  | {
      /** no valid record could be read */
      recorded: false;
      /** non-secret reason */
      reason: string;
    };

/**
 * turns text the governor records, such as an adapter's failure message, into
 * one bounded line the record's own validation accepts
 * @param text text from any source
 * @returns the text with each control character replaced by a space, cut to
 * the diagnostic length
 */
export function recordableText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ').slice(0, DIAGNOSTIC_LENGTH);
}

/**
 * validates a governor report at a trust boundary
 * @param value untrusted decoded report
 * @returns whether the report is complete and its state valid
 */
export function isGovernorReport(value: unknown): value is GovernorReport {
  return (
    isRecord(value) &&
    ((value.recorded === true && isGovernorState(value.state)) ||
      (value.recorded === false && isText(value.reason)))
  );
}

/**
 * validates a decoded governor state record field by field
 * @param value untrusted decoded record
 * @returns whether every field has its type and bound
 */
export function isGovernorState(value: unknown): value is GovernorState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isInstant(value.updatedAt) &&
    (value.keepAwakeMode === undefined ||
      isKeepAwakeMode(value.keepAwakeMode)) &&
    isMinutes(value.idleTimeoutMinutes) &&
    isMinutes(value.holdMaxMinutes) &&
    (value.lastHeartbeat === undefined || isInstant(value.lastHeartbeat)) &&
    hasRecordedHolds(value) &&
    (value.deadline === undefined || isInstant(value.deadline)) &&
    typeof value.sleepPermitted === 'boolean' &&
    (value.adapter === undefined || isAdapterResult(value.adapter)) &&
    isStringArray(value.diagnostics) &&
    value.diagnostics.length <= DIAGNOSTIC_LIMIT &&
    value.diagnostics.every(isText)
  );
}

/**
 * validates the recorded holds and their count
 * @param value untrusted decoded record
 * @returns whether the record lists at most the recorded limit of valid holds
 * and counts no fewer open holds than it lists
 */
function hasRecordedHolds(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.holds) &&
    value.holds.length <= RECORDED_HOLD_LIMIT &&
    value.holds.every(isRecordedHold) &&
    isMinutes(value.openHolds) &&
    value.openHolds >= value.holds.length
  );
}

/**
 * validates one recorded hold
 * @param value untrusted decoded hold
 * @returns whether the hold is complete
 */
function isRecordedHold(value: unknown): value is RecordedHold {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    SOURCE_NAME.test(value.source) &&
    typeof value.session === 'string' &&
    SESSION_HASH.test(value.session) &&
    isInstant(value.expiresAt)
  );
}

/**
 * validates the recorded adapter call
 * @param value untrusted decoded result
 * @returns whether the result names its action and exactly one outcome
 */
export function isAdapterResult(value: unknown): value is AdapterResult {
  return (
    isRecord(value) &&
    isInstant(value.at) &&
    ADAPTER_ACTIONS.includes(value.action) &&
    (value.result === undefined) !== (value.failure === undefined) &&
    (value.result === undefined || isText(value.result)) &&
    (value.failure === undefined || isText(value.failure))
  );
}

/**
 * validates an ISO 8601 instant
 * @param value untrusted field
 * @returns whether the value is an instant `Date` writes back unchanged
 */
function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > INSTANT_LENGTH) {
    return false;
  }
  const time = Date.parse(value);

  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * validates a whole-number field
 * @param value untrusted field
 * @returns whether the value is a non-negative safe integer
 */
function isMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * validates a bounded text field that a terminal shows as it is
 * @param value untrusted field
 * @returns whether the value is a string within the diagnostic length that
 * holds no C0 or C1 control character
 */
function isText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DIAGNOSTIC_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}
