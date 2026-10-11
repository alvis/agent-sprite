/**
 * Checks whether an unknown value is a non-array object.
 * @param value unknown candidate
 * @returns whether the value is a non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
