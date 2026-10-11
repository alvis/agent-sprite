import { isRecord } from './records.js';
import { mergeManifestUpdate } from './update-manifest.js';

/** fixed non-secret observations used to diagnose update failure */
export interface UpdateFailureContext {
  step: string;
  installerRan: boolean;
  releaseFailed?: boolean;
}

const manifestPath = '/opt/agent-sprite/manifest.json';

/** safe updater step diagnostic with the original failure retained privately */
export class UpdateFailure extends Error {
  public override readonly name = 'UpdateFailure';
}

/**
 * exposes recorded safe diagnostics while withholding unclassified failure details
 * @param error updater rejection whose raw cause must remain private
 * @returns public updater failure diagnostic
 */
export function updaterFailureMessage(error: unknown): string {
  return error instanceof UpdateFailure
    ? `Managed updater failed: ${error.message}.`
    : 'Managed updater failed; inspect the installation manifest.';
}

/**
 * persists only fixed step and numeric status facts while retaining raw causes internally
 * @param context fixed update observations
 * @param error original update failure
 * @param recoveryError task-hold release failure after an earlier failure
 * @returns safe wrapper retaining the original rejection as cause
 */
export async function recordUpdateFailure(
  context: UpdateFailureContext,
  error: unknown,
  recoveryError: unknown,
): Promise<UpdateFailure> {
  const status =
    isRecord(error) &&
    typeof error.status === 'number' &&
    Number.isInteger(error.status)
      ? error.status
      : undefined;
  const statusSuffix = status === undefined ? '' : ` (exit ${status})`;
  const logHint =
    context.installerRan && context.step === 'install-tools'
      ? '; see /opt/agent-sprite/install-tools.log'
      : '';
  const releaseHint =
    context.releaseFailed && context.step !== 'task hold release'
      ? '; task hold release also failed'
      : '';
  const lastUpdateError = `${context.step} failed${statusSuffix}${logHint}${releaseHint}`;
  let persistenceError: unknown;
  try {
    await mergeManifestUpdate(manifestPath, {
      lastUpdateStatus: 'failed',
      lastUpdateError,
    });
  } catch (failure) {
    persistenceError = failure;
  }

  const secondary = [recoveryError, persistenceError].filter(Boolean);

  return new UpdateFailure(lastUpdateError, {
    cause:
      secondary.length > 0
        ? new AggregateError(
            [error, ...secondary],
            'Update recovery had additional failures',
          )
        : error,
  });
}
