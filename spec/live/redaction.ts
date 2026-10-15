/** removes dotenv-supplied values from text before it can reach a report */
export type Redactor = (text: string) => string;

/** shorter values would collide with ordinary output words */
const MINIMUM_REDACTED_LENGTH = 4;

/** interaction and display switches carry no confidential value */
const CONTROL_NAMES = new Set(['CI', 'NON_INTERACTIVE', 'NO_COLOR', 'TERM']);

/**
 * builds a redactor for every confidential or identifying dotenv value
 * @param values parsed dotenv values
 * @returns function replacing each value form, longest first, with its variable name
 */
export function createRedactor(values: Record<string, string>): Redactor {
  const replacements = Object.entries(values)
    .filter(([name]) => !CONTROL_NAMES.has(name) && !name.endsWith('_ENABLED'))
    .flatMap(([name, raw]) =>
      [...redactedForms(raw.trim())]
        .filter((value) => value.length >= MINIMUM_REDACTED_LENGTH)
        .map((value) => ({ name, value })),
    )
    .sort((left, right) => right.value.length - left.value.length);

  return (text) =>
    replacements.reduce(
      (redacted, { name, value }) =>
        redacted.split(value).join(`[redacted:${name}]`),
      text,
    );
}

/**
 * lists the textual forms in which a value can reach command output
 * @param value trimmed dotenv value
 * @returns raw, JSON-escaped, URL-encoded and, for URLs, origin and host forms
 */
function redactedForms(value: string): Set<string> {
  const bare = value.replace(/\/$/u, '');
  const url = URL.canParse(value) ? new URL(value) : undefined;

  return new Set([
    bare,
    JSON.stringify(bare).slice(1, -1),
    encodeURIComponent(bare),
    ...(url?.host ? [url.host] : []),
  ]);
}
