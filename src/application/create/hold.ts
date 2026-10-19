import { randomUUID } from 'node:crypto';

import { recoverOperation } from '#kernel/operation';

import type { GuestChannel } from '#application/ports/guest-channel';

const MILLISECONDS_PER_MINUTE = 60_000;
const REFRESH_MINUTES = 5;

/** the managed operation the hold is recorded for, as `--source` names it */
const HOLD_SOURCE = 'create';

/** longest one hold event may run on the guest */
const HOLD_EVENT_LIMIT_MS = 10_000;

/**
 * wait before the open is repeated while the governor has not taken it: the
 * awake command exists only once the first setup step has staged it
 */
const OPEN_RETRY_MS = 15_000;

/**
 * wait between refreshes of an open hold, far inside the hold maximum, which
 * is an hour unless set shorter
 */
const REFRESH_MS = REFRESH_MINUTES * MILLISECONDS_PER_MINUTE;

type HoldAction = 'hold-open' | 'hold-close';

/**
 * keeps a workstation being created awake, so an idle timeout shorter than
 * the setup cannot suspend it between the steps that hold no awake claim of
 * their own, such as the wait for the agent to serve and the exposure. It uses
 * the idle governor's managed hold, which every provider shares: the hold is
 * opened as root, refreshed while the work runs, and closed when the work ends,
 * whether it succeeded or failed. A hold that cannot be opened, refreshed or
 * closed never fails the creation; the governor counts it as idleness, and an
 * unclosed hold lapses at the hold maximum
 * @param awakeCommand the guest command that opens and closes the hold
 * @param guest the newly created workstation's guest
 * @param work the creation steps to protect
 * @returns the work's result
 */
export async function withCreateHold<T>(
  awakeCommand: string,
  guest: GuestChannel,
  work: () => Promise<T>,
): Promise<T> {
  const session = `create-${randomUUID()}`;
  const report = async (action: HoldAction): Promise<boolean> =>
    guest
      .exec({
        program: awakeCommand,
        arguments: [action, '--source', HOLD_SOURCE, '--session', session],
        timeoutMs: HOLD_EVENT_LIMIT_MS,
      })
      .then(
        ({ exitCode }) => exitCode === 0,
        () => false,
      );
  let isStopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const keep = async (): Promise<void> => {
    const isOpen = await report('hold-open');
    if (!isStopped) {
      timer = setTimeout(
        () => {
          pending = keep();
        },
        isOpen ? REFRESH_MS : OPEN_RETRY_MS,
      );
      // the hold never keeps the process alive after the creation
      timer.unref();
    }
  };
  pending = keep();
  try {
    return await work();
  } finally {
    isStopped = true;
    clearTimeout(timer);
    await pending;
    // closing must still run for a creation that was cancelled
    await recoverOperation(async () => report('hold-close')).catch(
      () => undefined,
    );
  }
}
