const secretValues = new Set<string>();

/**
 * retains a secret in memory for later diagnostic redaction
 * @param value credential value to exclude from diagnostics
 */
export function rememberSecret(value: string | undefined): void {
  if (value) {
    secretValues.add(value);
  }
}

/**
 * redacts all credentials resolved during this process
 * @param message diagnostic text to sanitize
 * @returns text with resolved credential values removed
 */
export function redactResolved(message: string): string {
  return redact(message, [...secretValues]);
}

/**
 * permits one native pairing value while preserving unrelated credential redaction
 * @param message marked pairing material
 * @param token the exact native pairing code permitted for this value
 * @returns pairing material sanitized for every other registered credential
 */
export function redactForPairing(message: string, token: string): string {
  return redact(
    message,
    [...secretValues].filter((value) => value !== token),
  );
}

/**
 * removes known secret values from diagnostic text
 * @param message diagnostic text to sanitize
 * @param secrets credential values to exclude
 * @returns text with credential values replaced by redaction markers
 */
export function redact(
  message: string,
  secrets: ReadonlyArray<string | undefined>,
): string {
  const values = [
    ...new Set(secrets.filter((secret): secret is string => Boolean(secret))),
  ].sort((left, right) => right.length - left.length);
  if (values.length === 0) {
    return message;
  }
  const pattern = new RegExp(
    values
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('|'),
    'gu',
  );

  return message.replace(pattern, '[REDACTED]');
}
