import { randomUUID } from 'node:crypto';

import { withAwakeHold } from '../idle/hold.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The transaction worker lives exactly as long as the transaction it
// protects, so the workstation stays awake through an awake hold of the idle
// governor for that time (REQ-IDLE-7)

/**
 * longest the worker waits for the hold to open before it reports ready; the
 * governor's own bounds on an open (a lock wait, then a deadline apply) end
 * inside this
 */
const HOLD_OPEN_LIMIT_MS = 3_000;

/**
 * opens an awake hold for one transaction, and waits for the open to be
 * recorded or to give up, within a time bound, so the worker never reports
 * ready before the workstation is held awake. The hold never fails the
 * transaction: an open that fails or outlasts the bound is left to the
 * governor, which records it, and the work runs regardless; a worker that
 * crashes leaves its hold to lapse at the hold maximum
 * @param openLimitMs longest to wait for the open
 * @returns closes the hold and settles once it is closed; safe to call twice
 */
export async function holdForTransaction(
  openLimitMs: number = HOLD_OPEN_LIMIT_MS,
): Promise<() => Promise<void>> {
  const end = { resolve: (): void => undefined };
  const ended = new Promise<void>((resolve) => {
    end.resolve = resolve;
  });
  const opened = { resolve: (): void => undefined };
  const isOpen = new Promise<void>((resolve) => {
    opened.resolve = resolve;
  });
  // the protected operation starts only once the open has been recorded
  const hold = withAwakeHold(
    { source: 'transaction', session: randomUUID() },
    async () => {
      opened.resolve();
      await ended;
    },
  ).catch(() => {
    opened.resolve();
  });
  const timer = setTimeout(opened.resolve, openLimitMs);
  await isOpen;
  clearTimeout(timer);

  return async () => {
    end.resolve();
    await hold;
  };
}
