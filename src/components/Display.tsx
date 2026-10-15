import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { labelFor } from './ResultDetails.js';

import type { ProgressUpdate, StatusUpdate } from '#command';

const DEFAULT_COLUMNS = 80;
const NAME_WIDTH = 20;
const ID_WIDTH = 26;
const STATE_WIDTH = 14;
const CREATED_WIDTH = 26;
const SETUP_WIDTH = 14;
const ORGANIZATION_WIDTH = 20;
const MIN_URL_WIDTH = 24;
const FIXED_TABLE_WIDTH =
  NAME_WIDTH +
  ID_WIDTH +
  STATE_WIDTH +
  CREATED_WIDTH +
  SETUP_WIDTH +
  ORGANIZATION_WIDTH;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;
const MILLISECONDS_PER_SECOND = 1000;
const SINGLE_WIDTH_TEXT = /^[\u0020-\u007e]*$/u;

/**
 * reflects stages actually reported by the workflow
 * @param root0 progress props
 * @param root0.update reported stage and counts
 * @param root0.startedAt stage start time for a live interactive indicator
 * @returns current stage with live or completed timing
 */
export function TaskProgress({
  update,
  startedAt,
}: Readonly<{
  update: ProgressUpdate;
  startedAt?: number;
}>): React.JSX.Element {
  const [tick, setTick] = useState(0);
  const live = startedAt !== undefined && update.phase !== 'complete';
  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = setInterval(
      () => setTick((value) => value + 1),
      SPINNER_INTERVAL_MS,
    );

    return () => clearInterval(timer);
  }, [live, startedAt]);
  const count =
    update.completed === undefined || update.total === undefined
      ? ''
      : ` ${update.completed}/${update.total}`;
  const elapsed = live
    ? ` (${Math.max(0, Math.floor((Date.now() - startedAt) / MILLISECONDS_PER_SECOND))}s)`
    : update.durationMs === undefined
      ? ''
      : ` (${(update.durationMs / MILLISECONDS_PER_SECOND).toFixed(1)}s)`;
  const indicator =
    update.phase === 'complete'
      ? update.outcome === 'failed'
        ? '✗ '
        : '✓ '
      : live
        ? `${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} `
        : '';

  return (
    <Text>
      {indicator}
      {update.stage}
      {count}: {update.message}
      {elapsed}
    </Text>
  );
}

/**
 * includes a word indicator as well as color in status text
 * @param root0 status props
 * @param root0.update reported status
 * @param root0.noColor whether color is disabled
 */
export function StatusMessage({
  update,
  noColor = false,
}: Readonly<{ update: StatusUpdate; noColor?: boolean }>): React.JSX.Element {
  const color = noColor
    ? undefined
    : update.kind === 'error'
      ? 'red'
      : update.kind === 'warning'
        ? 'yellow'
        : update.kind === 'success'
          ? 'green'
          : undefined;

  return (
    <Text color={color}>
      {update.kind.toUpperCase()}: {update.message}
    </Text>
  );
}

/**
 * renders a compact non-secret detail panel
 * @param root0 panel props
 * @param root0.title heading shown above the rows
 * @param root0.entries key-value rows
 */
export function KeyValuePanel({
  title,
  entries,
}: Readonly<{
  title: string;
  entries: ReadonlyArray<readonly [string, string]>;
}>): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {entries.map(([key, value]) => (
        <Text key={key}>
          {labelFor(key)}: {value}
        </Text>
      ))}
    </Box>
  );
}

/**
 * renders a machine list with a narrow-terminal vertical fallback
 * @param root0 table props
 * @param root0.machines live machine summaries
 * @param root0.columns terminal width
 */
export function MachineTable({
  machines,
  columns = DEFAULT_COLUMNS,
}: Readonly<{
  machines: ReadonlyArray<Record<string, string>>;
  columns?: number;
}>): React.JSX.Element {
  const urlWidth = machines.reduce(
    (width, machine) => Math.max(width, machine.agentUrl?.length ?? 0),
    MIN_URL_WIDTH,
  );
  const fitsWideTable =
    columns >= FIXED_TABLE_WIDTH + urlWidth &&
    machines.every(
      (machine) =>
        Object.values(machine).every((value) =>
          SINGLE_WIDTH_TEXT.test(value),
        ) &&
        (machine.name?.length ?? 0) < NAME_WIDTH &&
        (machine.id?.length ?? 0) < ID_WIDTH &&
        (machine.state?.length ?? 0) < STATE_WIDTH &&
        (machine.createdAt?.length ?? 0) < CREATED_WIDTH &&
        (machine.setup?.length ?? 0) < SETUP_WIDTH &&
        (machine.organization?.length ?? 0) < ORGANIZATION_WIDTH,
    );
  if (!fitsWideTable) {
    return (
      <Box flexDirection="column">
        {machines.map((machine, index) => (
          <KeyValuePanel
            entries={Object.entries(machine)}
            key={machine.id ?? machine.name ?? String(index)}
            title={`Workstation ${machine.name ?? machine.id ?? String(index + 1)}`}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>
        {tableCell('WORKSTATION', NAME_WIDTH)}
        {tableCell('ID', ID_WIDTH)}
        {tableCell('STATE', STATE_WIDTH)}
        {tableCell('CREATED', CREATED_WIDTH)}
        {tableCell('SETUP', SETUP_WIDTH)}
        {tableCell('ORGANIZATION', ORGANIZATION_WIDTH)}
        AGENT URL
      </Text>
      {machines.map((machine, index) => (
        <Text key={machine.id ?? machine.name ?? String(index)}>
          {tableCell(machine.name, NAME_WIDTH)}
          {tableCell(machine.id, ID_WIDTH)}
          {tableCell(machine.state, STATE_WIDTH)}
          {tableCell(machine.createdAt, CREATED_WIDTH)}
          {tableCell(machine.setup ?? 'not recorded', SETUP_WIDTH)}
          {tableCell(machine.organization ?? 'unknown', ORGANIZATION_WIDTH)}
          {machine.agentUrl ?? 'not recorded'}
        </Text>
      ))}
    </Box>
  );
}

/**
 * keeps the final table column free for an unbroken agent URL
 * @param value column value
 * @param width space reserved for this column
 * @returns one padded table cell
 */
function tableCell(value: string | undefined, width: number): string {
  return (value ?? '').slice(0, width - 1).padEnd(width);
}
