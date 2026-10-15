import { access, readFile } from 'node:fs/promises';

import { isRecord } from '../records.js';

// guest kernel: imports only Node built-ins and other guest code. A process is
// identified by its id and its start time (field 22 of `/proc/<pid>/stat`, in
// clock ticks since boot), so a recycled process id is never mistaken for the
// process that recorded a managed hold

/** the default location of the process table */
export const PROC_ROOT = '/proc';

/** the process behind a managed hold */
export interface HolderProcess {
  /** process id */
  pid: number;
  /** the process's start time as the process table reports it */
  start: string;
}

/** the process-table field that is the first after the command name, in the stat line */
const FIELDS_BEFORE_START = 3;
const START_FIELD = 22;
const START_PATTERN = /^\d{1,20}$/u;

/**
 * validates a decoded process record
 * @param value untrusted decoded value
 * @returns whether it holds a positive process id and a numeric start time
 */
export function isHolderProcess(value: unknown): value is HolderProcess {
  return (
    isRecord(value) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.start === 'string' &&
    START_PATTERN.test(value.start)
  );
}

/**
 * reads what the process table says about a process
 * @param pid process id
 * @param procRoot location of the process table
 * @returns its state letter and start time; 'absent' when it does not exist;
 * undefined when the table cannot say, such as on a system without one
 */
async function readStat(
  pid: number,
  procRoot: string,
): Promise<{ state: string; start: string } | 'absent' | undefined> {
  const text = await readFile(`${procRoot}/${pid}/stat`, 'utf8').catch(
    async (error: unknown) =>
      isRecord(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')
        ? // a system without a process table cannot say a process is gone
          access(procRoot).then(
            () => 'absent' as const,
            () => undefined,
          )
        : undefined,
  );
  if (text === undefined || text === 'absent') {
    return text;
  }
  // the command name sits in parentheses and may hold spaces or parentheses
  const fields = text
    .slice(text.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const start = fields[START_FIELD - FIELDS_BEFORE_START];

  return state !== undefined && start !== undefined && START_PATTERN.test(start)
    ? { state, start }
    : undefined;
}

/**
 * identifies a running process
 * @param pid process id
 * @param procRoot location of the process table
 * @returns the process, or undefined when its start time cannot be read
 */
export async function identifyProcess(
  pid: number,
  procRoot: string = PROC_ROOT,
): Promise<HolderProcess | undefined> {
  const stat = await readStat(pid, procRoot);

  return stat === undefined || stat === 'absent' || stat.state === 'Z'
    ? undefined
    : { pid, start: stat.start };
}

/**
 * tells whether the process that recorded a hold has ended: it no longer
 * exists, has become a zombie, or its id now belongs to a process that started
 * at another time
 * @param process the recorded process
 * @param procRoot location of the process table
 * @returns true only when the table shows the process is gone; a table that
 * cannot be read never prunes a hold
 */
export async function isProcessGone(
  process: HolderProcess,
  procRoot: string = PROC_ROOT,
): Promise<boolean> {
  const stat = await readStat(process.pid, procRoot);
  if (stat === undefined) {
    return false;
  }

  return (
    stat === 'absent' || stat.state === 'Z' || stat.start !== process.start
  );
}
