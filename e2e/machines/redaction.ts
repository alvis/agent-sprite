import { TEST_PREFIX } from './identity';

/** removes e2e credential values from text before it can reach a report */
export type Redactor = (text: string) => string;

/** shorter values would collide with ordinary output words */
const MINIMUM_REDACTED_LENGTH = 4;

/**
 * builds a redactor for every `TEST_*` value of an environment and for any
 * secret the run derives from them
 * @param environment process environment holding the e2e credentials
 * @param derived further secrets by the label they are replaced with, such as a token derived from a credential
 * @returns function replacing each value form, longest first, with its label
 */
export function createRedactor(
  environment: NodeJS.ProcessEnv,
  derived: Readonly<Record<string, string>> = {},
): Redactor {
  const secrets = [
    ...Object.entries(environment).filter(([name]) =>
      name.startsWith(TEST_PREFIX),
    ),
    ...Object.entries(derived),
  ];
  const replacements = secrets
    .flatMap(([name, raw]) =>
      [...redactedForms((raw ?? '').trim())]
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
 * @param value trimmed credential value
 * @returns raw, JSON-escaped, URL-encoded, base64 and, for URLs, host forms
 */
function redactedForms(value: string): Set<string> {
  const bare = value.replace(/\/$/u, '');
  const url = URL.canParse(value) ? new URL(value) : undefined;
  const encoded = Buffer.from(bare);

  return new Set([
    bare,
    JSON.stringify(bare).slice(1, -1),
    encodeURIComponent(bare),
    // a header or a config file may carry the value base64-encoded
    // padding sits only at the end, and a padded value need not end where the text does
    encoded.toString('base64').replaceAll('=', ''),
    encoded.toString('base64url'),
    ...(url?.host ? [url.host] : []),
  ]);
}
