/**
 * parses a whole number, leaving its bounds to profile validation
 * @param value flag text
 * @returns the integer
 * @throws {Error} when the text is not a whole number
 */
export function parseWholeNumber(value: string): number {
  if (!/^-?\d+$/u.test(value.trim())) {
    throw new Error(`expected a whole number, got ${JSON.stringify(value)}`);
  }

  return Number(value);
}
