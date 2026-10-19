import { HARNESS_IDS } from '#domain/ids';

import type { HarnessId } from '#domain/ids';

/**
 * names a harness the way prompts and readiness checks address it
 * @param id harness identifier
 * @returns the identifier with its first letter capitalized
 */
export function harnessLabel(id: HarnessId): string {
  return `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;
}

/**
 * recognizes the identifier of a registered harness driver
 * @param value candidate identifier
 * @returns whether a harness driver is registered under it
 */
export function isHarnessId(value: string): value is HarnessId {
  return HARNESS_IDS.some((id) => id === value);
}

/**
 * lists the identifiers of every registered harness driver
 * @returns harness identifiers in registration order
 */
export function harnessIds(): HarnessId[] {
  return [...HARNESS_IDS];
}
