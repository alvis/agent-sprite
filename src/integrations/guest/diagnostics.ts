import { redactResolved } from '#utilities/redaction';

const ESCAPE = '\u001B';
const BELL = '\u0007';
// matches CSI and OSC terminal control sequences; built from string escapes so
// the pattern literal holds no raw control characters
const terminalEscape = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)?)`,
  'gu',
);

/**
 * removes registered secrets and terminal controls before any diagnostic limit
 * @param value untrusted guest text
 * @returns bounded-output-safe diagnostic text
 */
export function sanitizeGuestDiagnostic(value: string): string {
  return redactResolved(value)
    .replace(terminalEscape, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .trim();
}
