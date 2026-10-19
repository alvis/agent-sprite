import { checkOperation, runOperation } from '#kernel/operation';

import type { GuestInspection } from '#domain/observations/inspection';

/**
 * a freshly started agent answers its environment endpoint only after it has
 * opened its state, which a 2-CPU shared guest needed up to about four
 * minutes for, its event loop stalling for seconds while it started
 */
const MILLISECONDS_PER_MINUTE = 60_000;
const SERVING_WAIT_MINUTES = 4;
const SERVING_WAIT_MS = SERVING_WAIT_MINUTES * MILLISECONDS_PER_MINUTE;
const SERVING_RETRY_MS = 10_000;

/**
 * waits for a guest whose agent service has just been started to answer its
 * environment endpoint, polling only that one cheap check so the wait does not
 * compete with the starting agent for CPU, then inspects the guest in full once
 * @param probe takes the agent's own environment check, one guest round trip
 * @param inspect takes the full guest inspection, which runs once after the wait
 * @returns the full inspection made once the agent answered or the wait was over
 */
export async function inspectUntilServing(
  probe: () => Promise<{ ok: boolean } | undefined>,
  inspect: () => Promise<GuestInspection>,
): Promise<GuestInspection> {
  const deadline = Date.now() + SERVING_WAIT_MS;
  for (;;) {
    const environment = await probe();
    if (environment?.ok === true || Date.now() + SERVING_RETRY_MS > deadline) {
      break;
    }
    await runOperation(
      async () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, SERVING_RETRY_MS);
        }),
    );
    checkOperation();
  }

  return inspect();
}
