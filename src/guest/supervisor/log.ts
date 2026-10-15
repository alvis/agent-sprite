import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

// guest kernel: imports only Node built-ins. Every line the supervisor logs
// is one `key=value` record behind an ISO 8601 instant, appended to a
// root-only file beside the other guest logs and echoed to the provider's
// console log; a log that cannot be written never stops the supervisor

/** a log's size beyond which a trim cuts it */
export const LOG_LIMIT_BYTES = 524_288;
/** how much of a log a trim keeps */
export const LOG_KEPT_BYTES = 262_144;
/** mode of every log the supervisor writes: root reads and writes it alone */
export const LOG_FILE_MODE = 0o600;

/** the longest value one field records */
const VALUE_LIMIT = 512;
/** a C0 or C1 control character, which could start a forged record */
const CONTROL_CHARACTERS = /\p{Cc}/gu;
/** opens a log for appending, never through a link */
const APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW;

/** one logged record, its fields in the order given */
export type LogFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

/** where the supervisor records what it did */
export interface SupervisorLog {
  /**
   * appends one record
   * @param fields the record's fields; an undefined field is left out
   */
  write: (fields: LogFields) => void;
}

/** where a log is written */
export interface FileLogParams {
  /** absolute log path */
  path: string;
  /** current epoch milliseconds */
  now: () => number;
  /** writes the line to the provider's console as well, when given */
  echo?: (line: string) => void;
}

/**
 * builds the supervisor's log over one file
 * @param params the log path, the clock and the console echo
 * @returns a writer appending each record to the file
 */
export function fileLog(params: FileLogParams): SupervisorLog {
  return {
    write: (fields) => {
      const line = `${new Date(params.now()).toISOString()} ${formatFields(fields)}\n`;
      params.echo?.(line);
      appendLine(params.path, line);
    },
  };
}

/**
 * renders a record as `key=value` pairs, quoting a value that holds a space,
 * a quote or an equals sign, and replacing every control character so a value
 * can never forge a second record
 * @param fields the record's fields
 * @returns one line without its newline
 */
export function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .flatMap(([key, value]) =>
      value === undefined ? [] : [`${key}=${formatValue(String(value))}`],
    )
    .join(' ');
}

/**
 * cuts a log that has grown beyond its limit to its latest whole lines, in
 * place so a child appending to it keeps its file
 * @param path absolute log path
 */
export async function trimLog(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.size <= LOG_LIMIT_BYTES) {
    return;
  }
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const kept = Buffer.alloc(LOG_KEPT_BYTES);
    const { bytesRead } = await handle.read(
      kept,
      0,
      LOG_KEPT_BYTES,
      info.size - LOG_KEPT_BYTES,
    );
    const tail = kept.subarray(0, bytesRead);
    const start = tail.indexOf('\n') + 1;
    await handle.truncate(0);
    await handle.write(tail.subarray(start), 0, bytesRead - start, 0);
  } finally {
    await handle.close();
  }
}

/**
 * appends one line to a log, ignoring a failure: the record is also on the
 * console
 * @param path absolute log path
 * @param line the line with its newline
 */
function appendLine(path: string, line: string): void {
  try {
    const descriptor = openSync(path, APPEND_FLAGS, LOG_FILE_MODE);
    try {
      writeSync(descriptor, line);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // a full or missing volume must not stop the supervisor
  }
}

/**
 * renders one value on one line
 * @param value the value's text
 * @returns the value, cut and quoted when it needs to be
 */
function formatValue(value: string): string {
  const flat = value.replace(CONTROL_CHARACTERS, ' ').slice(0, VALUE_LIMIT);

  return flat === '' || /[\s"=]/u.test(flat) ? JSON.stringify(flat) : flat;
}
