import { setTimeout as delay } from 'node:timers/promises';

import { callSprites } from '#adapters/drivers/providers/sprite/failures';
import { sanitizeGuestDiagnostic } from '#kernel/diagnostics';
import { CommandFault } from '#kernel/faults';
import {
  checkOperation,
  currentOperation,
  runBoundedIO,
} from '#kernel/operation';

import type { ServiceLogEvent, ServiceLogStream, Sprite } from '@fly/sprites';

const serviceStartupTimeoutMs = 30_000;
const servicePollIntervalMs = 500;

/**
 * acquires a service stream and closes late arrivals after caller cancellation
 * @param action supported SDK service request, already translating SDK failures
 * @returns stream owned by the current invocation
 */
export async function openServiceStream(
  action: () => Promise<ServiceLogStream>,
): Promise<ServiceLogStream> {
  const operation = currentOperation();

  return runBoundedIO(async (signal) => {
    const stream = await action();
    if (signal?.aborted) {
      stream.close();
    }
    checkOperation(operation);
    signal?.throwIfAborted();

    return stream;
  }, operation);
}

/**
 * stops local stream consumption when cancellation ends its invocation
 * @param stream acquired SDK service stream
 * @param handler observes service events while the invocation remains active
 */
export async function consumeServiceStream(
  stream: ServiceLogStream,
  handler: (event: ServiceLogEvent) => void,
): Promise<void> {
  const operation = currentOperation();
  const close = (): void => stream.close();
  operation?.signal.addEventListener('abort', close, { once: true });
  try {
    await runBoundedIO(
      async (signal) =>
        stream.processAll((event) => {
          checkOperation(operation);
          signal?.throwIfAborted();
          handler(event);
        }),
      operation,
    );
  } finally {
    operation?.signal.removeEventListener('abort', close);
    stream.close();
  }
}

/**
 * consumes service startup events and rejects reported failures
 * @param name exact supervised service identity
 * @param stream supervised service startup events
 */
export async function drainServiceStartup(
  name: string,
  stream: ServiceLogStream,
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
export async function waitForService(
  sprite: Sprite,
  name: string,
): Promise<void> {
  const deadline = Date.now() + serviceStartupTimeoutMs;
  while (Date.now() < deadline) {
    const service = await runBoundedIO(async () =>
      callSprites(async () => sprite.getService(name)),
    );
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
