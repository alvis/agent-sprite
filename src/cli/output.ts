import { stderr, stdout } from 'node:process';

import { renderToString } from 'ink';

import {
  machineTableElement,
  resultDetailsElement,
} from '#components/OutputPresentation';

import { humanResultDetails } from './output/details.js';
import { isJsonObject, serializeResult } from './serialization.js';

import type { Writable } from 'node:stream';

import type { CommandResult } from '#command';
import type { CommandOptions } from '#command/contracts';

import type {
  JsonObject,
  JsonValue,
  SerializedResult,
} from './serialization.js';

interface ResultStream extends Writable {
  isTTY?: boolean;
  columns?: number;
}

interface ResultStreams {
  stdout: ResultStream;
  stderr: ResultStream;
}

/** fully rendered output with one selected destination */
export interface PreparedResult {
  channel: 'stdout' | 'stderr';
  text: string;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_STREAMS: ResultStreams = { stdout, stderr };
const LIST_TSV_COLUMNS = [
  'name',
  'id',
  'state',
  'createdAt',
  't3Url',
  'setup',
  'organization',
] as const;

/**
 * prepares the entire redacted result before any output is written
 * @param result completed application result
 * @param options resolved output controls
 * @param streams real output streams used only for terminal width
 * @returns one complete payload and its destination
 */
export function prepareResult(
  result: CommandResult,
  options: CommandOptions,
  streams: ResultStreams = DEFAULT_STREAMS,
): PreparedResult {
  const safe = serializeResult(result);
  if (options.json) {
    return { channel: 'stdout', text: `${JSON.stringify(safe)}\n` };
  }
  if (safe.ok && safe.command === 'list' && !streams.stdout.isTTY) {
    const rows = machineRows(safe.data);
    if (rows) {
      return { channel: 'stdout', text: formatListTsv(rows) };
    }
  }
  const channel = safe.ok ? 'stdout' : 'stderr';
  const stream = streams[channel];
  const columns = stream.isTTY
    ? (stream.columns ?? DEFAULT_COLUMNS)
    : DEFAULT_COLUMNS;

  return { channel, text: humanResult(safe, columns) };
}

/**
 * writes an already complete payload to its selected real stream once
 * @param prepared fully rendered result
 * @param streams real output streams, defaulting to the current process
 */
export function writePreparedResult(
  prepared: PreparedResult,
  streams: ResultStreams = DEFAULT_STREAMS,
): void {
  streams[prepared.channel].write(prepared.text);
}

/**
 * emits one prepared success or JSON result on stdout, or human failure on stderr
 * @param result completed application result
 * @param options resolved output controls
 * @param streams real output streams, defaulting to the current process
 */
export function writeResult(
  result: CommandResult,
  options: CommandOptions,
  streams: ResultStreams = DEFAULT_STREAMS,
): void {
  writePreparedResult(prepareResult(result, options, streams), streams);
}

/**
 * renders a completed result for a human reader
 * @param result redacted application result
 * @param columns available terminal width
 * @returns fully rendered human text
 */
function humanResult(result: SerializedResult, columns: number): string {
  const error = result.ok ? '' : humanError(result);
  if (!result.ok) {
    if (result.data === undefined) {
      return error;
    }
  }
  const machines = machineRows(result.data);
  if (result.command === 'list' && machines) {
    return `${error}${renderToString(machineTableElement(machines, columns))}\n`;
  }
  if (result.data) {
    const details = renderToString(
      resultDetailsElement(
        result.command ?? 'command',
        humanResultDetails(result.data),
      ),
      { columns },
    );

    return `${error}${details}\n${humanConnection(result.data)}`;
  }
  if (!result.ok) {
    return `${error}${String(result.data)}\n`;
  }

  return `${result.command}: complete\n`;
}

/**
 * prints the single T3 URL and optional code without wrapping so copying preserves them
 * @param data already redacted command data
 * @returns unwrapped connection lines
 */
function humanConnection(data: JsonObject): string {
  const lines: string[] = [];
  const machine = isJsonObject(data.machine) ? data.machine : undefined;
  const t3Url = machine?.t3Url ?? data.t3Url;
  if (typeof t3Url === 'string') {
    lines.push(`    T3 URL: ${t3Url}\n`);
  }
  const pairing = isJsonObject(data.pairing) ? data.pairing : undefined;
  if (typeof pairing?.token === 'string') {
    lines.push(`    Pairing code: ${pairing.token}\n`);
  }

  return lines.join('');
}

/**
 * shows failure details and the exact recoverable machine identity
 * @param result failed application result
 * @returns complete failure heading and recovery lines
 */
function humanError(result: Extract<SerializedResult, { ok: false }>): string {
  const lines = [`${result.error.message}\n`];
  if (result.error.machine) {
    lines.push(`Workstation: ${result.error.machine}\n`);
  }
  if (result.error.machineId) {
    lines.push(`Workstation ID: ${result.error.machineId}\n`);
  }
  if (result.error.setupIncomplete) {
    lines.push(
      'Setup is incomplete; run agent-sprite setup on this workstation.\n',
    );
  }
  const recovery = isJsonObject(result.data?.recovery)
    ? result.data.recovery
    : undefined;
  if (
    recovery?.incompleteLabel === 'confirmed' ||
    recovery?.incompleteLabel === 'unconfirmed'
  ) {
    lines.push(`Incomplete label: ${recovery.incompleteLabel}\n`);
  }
  for (const detail of result.error.details ?? []) {
    lines.push(`  ${detail}\n`);
  }

  return lines.join('');
}

/**
 * formats redacted list rows as one headerless TSV record per workstation
 * @param rows printable workstation fields
 * @returns escaped tab-separated records, or no text for an empty list
 */
function formatListTsv(rows: Array<Record<string, string>>): string {
  return rows.length === 0
    ? ''
    : `${rows
        .map((row) =>
          LIST_TSV_COLUMNS.map((column) =>
            escapeTsvCell(row[column] ?? ''),
          ).join('\t'),
        )
        .join('\n')}\n`;
}

/**
 * escapes record delimiters and literal backslashes in one TSV field
 * @param value redacted field value
 * @returns field with delimiters, backslashes, and ANSI introducers escaped
 */
function escapeTsvCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\u001b', '\\u001b')
    .replaceAll('\u009b', '\\u009b');
}

/**
 * selects machine rows from the application result
 * @param data command data
 * @returns printable machine rows, when present
 */
function machineRows(
  data: JsonObject | undefined,
): Array<Record<string, string>> | undefined {
  const candidate = data?.machines;
  if (!Array.isArray(candidate)) {
    return undefined;
  }

  const rows: JsonValue[] = candidate;

  return rows.map((item) => {
    if (!isJsonObject(item)) {
      return {
        name: typeof item === 'object' ? JSON.stringify(item) : String(item),
      };
    }

    return Object.fromEntries(
      Object.entries(item).map(([key, value]) => [
        key,
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value),
      ]),
    );
  });
}
