/** update and release failures retained independently */
export interface HeldUpdateFailure {
  error: unknown;
  releaseError: unknown;
  releaseOnly: boolean;
  releaseFailed: boolean;
}
/** actual task hold, work and failure-recording operations */
export interface HeldUpdateActions {
  acquire: () => Promise<void>;
  release: () => Promise<void>;
  work: () => Promise<void>;
  recordFailure: (failure: HeldUpdateFailure) => Promise<Error>;
}
/** outcomes settled before writing failure status */
interface HeldUpdateState {
  failed: boolean;
  failure: unknown;
  releaseFailed: boolean;
  releaseFailure: unknown;
}

/**
 * runs one update under a task hold and records failure after release is attempted
 * @param actions real update and hold actions
 * @returns when work, release, and status recording succeed
 */
export async function runHeldUpdate(actions: HeldUpdateActions): Promise<void> {
  let acquired = false;
  let failed = false;
  let failure: unknown;
  let releaseFailed = false;
  let releaseFailure: unknown;
  try {
    await actions.acquire();
    acquired = true;
    await actions.work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (acquired) {
    try {
      await actions.release();
    } catch (error) {
      releaseFailed = true;
      releaseFailure = error;
    }
  }
  if (failed || releaseFailed) {
    await reportHeldFailure(actions, {
      failed,
      failure,
      releaseFailed,
      releaseFailure,
    });
  }
}

/**
 * reports the failed held update without replacing its primary on status-write failure
 * @param actions status recorder
 * @param state settled work and release outcomes
 * @returns always rejects with the recorded or original failure
 */
async function reportHeldFailure(
  actions: HeldUpdateActions,
  state: HeldUpdateState,
): Promise<never> {
  const { failed, failure, releaseFailed, releaseFailure } = state;
  const primary = failed ? failure : releaseFailure;
  let recorded: Error;
  try {
    recorded = await actions.recordFailure({
      error: primary,
      releaseError: failed ? releaseFailure : undefined,
      releaseOnly: !failed && releaseFailed,
      releaseFailed,
    });
  } catch (storageFailure) {
    throw retainUpdaterFailure(
      primary,
      failed && releaseFailed
        ? [releaseFailure, storageFailure]
        : [storageFailure],
    );
  }
  throw recorded;
}

/**
 * retains a failed update when recording its status also fails
 * @param primary original work, acquire, or release rejection
 * @param secondary release and status-write failures
 * @returns original error with its prior cause and recovery errors
 */
function retainUpdaterFailure(primary: unknown, secondary: unknown[]): Error {
  const error =
    primary instanceof Error
      ? primary
      : new Error('Managed update failed', { cause: primary });
  const prior = error.cause;
  const causes = [...(prior === undefined ? [] : [prior]), ...secondary];
  try {
    error.cause = new AggregateError(
      causes,
      'Update recovery had additional failures',
    );
  } catch {
    /* preserve a frozen primary error even if its cause cannot be expanded */
  }

  return error;
}
