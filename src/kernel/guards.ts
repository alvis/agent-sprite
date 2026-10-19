/**
 * Checks whether an unknown value is a non-array object.
 * @param value unknown candidate
 * @returns whether the value is a non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * checks whether an unknown value is an array of strings
 * @param value candidate value
 * @returns true for a string array
 */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
