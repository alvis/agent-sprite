import { MachineTable } from './Display';
import { ResultDetails } from './ResultDetails';

import type { ReactElement } from 'react';

import type { JsonObject } from '#cli/serialization';

/**
 * creates the human-readable machine table element
 * @param machines already selected machine rows
 * @param columns available terminal width
 * @returns Ink node laid out for the available terminal width
 */
export function machineTableElement(
  machines: ReadonlyArray<Record<string, string>>,
  columns: number,
): ReactElement {
  return <MachineTable columns={columns} machines={machines} />;
}

/**
 * creates the human-readable detail element
 * @param title result group heading
 * @param value already redacted result details
 * @returns the detail element
 */
export function resultDetailsElement(
  title: string,
  value: JsonObject,
): ReactElement {
  return <ResultDetails title={title} value={value} />;
}
