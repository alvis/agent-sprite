/**
 * narrows external JSON objects before their fields are inspected
 * @param value untrusted decoded value
 * @returns whether the value is a non-array record
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * validates an external string array without discarding malformed entries
 * @param value untrusted decoded value
 * @returns whether every entry is a string
 */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string')
  );
}
