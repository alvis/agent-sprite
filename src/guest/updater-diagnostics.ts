import { GUEST_ROOT } from './guest-root.js';
import { isRecord } from './records.js';
import { mergeManifestUpdate } from './update-manifest.js';

import type { ComponentOutcome } from './component-outcome.js';

/** fixed non-secret observations used to diagnose update failure */
export interface UpdateFailureContext {
  step: string;
  installerRan: boolean;
  /** what the installer did to each component before it failed, when it left any */
  componentOutcomes: Record<string, ComponentOutcome> | undefined;
}

const manifestPath = `${GUEST_ROOT}/manifest.json`;

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
 * @returns safe wrapper retaining the original rejection as cause
 */
export async function recordUpdateFailure(
  context: UpdateFailureContext,
  error: unknown,
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
      ? `; see ${GUEST_ROOT}/install-tools.log`
      : '';
  const lastUpdateError = `${context.step} failed${statusSuffix}${logHint}`;
  let persistenceError: unknown;
  try {
    await mergeManifestUpdate(manifestPath, {
      // this run's outcomes, or none: a failed run never leaves the outcomes
      // of an earlier run beside its failure
      componentOutcomes: context.componentOutcomes ?? null,
      lastUpdateStatus: 'failed',
      lastUpdateError,
    });
  } catch (failure) {
    persistenceError = failure;
  }

  return new UpdateFailure(lastUpdateError, {
    cause:
      persistenceError === undefined
        ? error
        : new AggregateError(
            [error, persistenceError],
            'Update recovery had additional failures',
          ),
  });
}
