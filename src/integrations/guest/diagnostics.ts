import { setTimeout as delay } from 'node:timers/promises';

import { CommandFault } from '#errors';
import { currentOperation, runBoundedIO } from '#operation';
import { redactResolved } from '#utilities/redaction';

import { consumeServiceStream } from './stream.js';

import type { ServiceLogEvent, Sprite } from '@fly/sprites';

const terminalEscape =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/gu;
const serviceStartupTimeoutMs = 30_000;
const servicePollIntervalMs = 500;

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

/**
 * consumes service startup events and rejects reported failures
 * @param name exact supervised service identity
 * @param stream supervised service startup events
 */
export async function drainServiceStartup(
  name: string,
  stream: Awaited<ReturnType<Sprite['createService']>>,
): Promise<void> {
  let failure: ServiceLogEvent | undefined;
  await consumeServiceStream(stream, (event) => {
    if (
      !failure &&
      (event.type === 'error' ||
        (event.type === 'exit' && event.exitCode !== 0))
    ) {
      failure = event;
    }
  });
  if (failure) {
    const status =
      failure.exitCode === undefined ? '' : ` (exit ${failure.exitCode})`;
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Sprite service ${sanitizeGuestDiagnostic(name)} reported ${failure.type}${status}`,
    });
  }
}

/**
 * waits for asynchronously updated service state after supervised startup
 * @param sprite target guest
 * @param name exact supervised service identity
 */
export async function waitForGuestService(
  sprite: Sprite,
  name: string,
): Promise<void> {
  const deadline = Date.now() + serviceStartupTimeoutMs;
  while (Date.now() < deadline) {
    const service = await runBoundedIO(async () => sprite.getService(name));
    if (service.state?.status === 'running') {
      return;
    }
    await delay(servicePollIntervalMs, undefined, {
      signal: currentOperation()?.signal,
    });
  }
  throw new CommandFault({
    code: 'PROVIDER',
    message: `Sprite service ${sanitizeGuestDiagnostic(name)} did not reach running state`,
  });
}
