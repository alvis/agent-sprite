import { tail } from '../cli';

import type { Redactor } from '../redaction';

/**
 * reads a guest script's result, so no test ever sees a credential the guest printed
 * @param result exit code and output of the script
 * @param result.exitCode the script's exit code
 * @param result.stdout its standard output
 * @param result.stderr its standard error
 * @param redact removes credential values
 * @returns the redacted standard output
 * @throws {Error} with the exit code and the end of the redacted standard
 * error when the script failed
 */
export function guestOutput(
  result: {
    exitCode: number;
    stdout: string | Buffer;
    stderr: string | Buffer;
  },
  redact: Redactor,
): string {
  if (result.exitCode !== 0) {
    throw new Error(
      `Guest script exited ${result.exitCode}: ${redact(tail(String(result.stderr)))}`,
    );
  }

  return redact(String(result.stdout));
}
