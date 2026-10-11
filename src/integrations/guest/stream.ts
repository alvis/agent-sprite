import { checkOperation, currentOperation, runBoundedIO } from '#operation';

import type { ServiceLogEvent, ServiceLogStream } from '@fly/sprites';

/**
 * acquires a service stream and closes late arrivals after caller cancellation
 * @param action supported SDK service request
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
