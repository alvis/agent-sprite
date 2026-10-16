import { commandError, ensureError, retainRecoveryFailure } from '#errors';
import { InteractionExit } from '#navigation';
import { recoverOperation } from '#operation';
import { ReadinessFault } from '#readiness';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import type { CommandResult } from '#command';
import type { SetupSection } from '#command/contracts';
import type { ProviderDriver, WorkstationRecord } from '#drivers/contracts';

import type { SetupProgress } from './context';

interface SetupFailureParams {
  provider: ProviderDriver;
  workstation: WorkstationRecord;
  mutation: SetupProgress;
  error: unknown;
  section?: SetupSection;
}

/**
 * reports failures and cancellation honestly after any guest mutation
 * @param params exact guest, caught failure, redaction values and mutation state
 * @returns failure with an explicit incomplete-setup marker when applicable
 */
export async function setupFailure(
  params: SetupFailureParams,
): Promise<CommandResult> {
  const { provider, workstation, mutation, section } = params;
  const error =
    params.error instanceof InteractionExit &&
    params.error.action === 'back' &&
    mutation.started
      ? new InteractionExit('cancel')
      : params.error;
  const primary = ensureError(error);
  const incompleteLabel = mutation.started
    ? await recoverIncompleteLabel(provider, workstation, primary)
    : undefined;
  const failure = commandError(primary);

  return {
    command: 'setup',
    ok: false,
    data:
      error instanceof ReadinessFault || incompleteLabel
        ? {
            ...(error instanceof ReadinessFault
              ? { readiness: error.readiness }
              : {}),
            ...(incompleteLabel ? { recovery: { incompleteLabel } } : {}),
          }
        : undefined,
    error: {
      ...failure,
      message:
        error instanceof InteractionExit &&
        error.action === 'cancel' &&
        mutation.started
          ? 'Setup stopped after changes began; workstation requires inspection and recovery.'
          : failure.message,
      machine: workstation.name,
      machineId: workstation.id,
      setupIncomplete: mutation.started ? true : undefined,
      details: [
        ...(failure.details ?? []),
        ...(incompleteLabel === 'unconfirmed'
          ? [
              'The incomplete label could not be confirmed; inspect provider state.',
            ]
          : []),
        // a usage refusal names its own fix; a bare section retry would drop it
        ...(section && failure.code !== 'USAGE'
          ? [
              `Failed setup section: ${section}`,
              `Retry: open-agent setup ${JSON.stringify(workstation.name)} --section ${section}`,
            ]
          : []),
      ],
    },
  };
}

/**
 * attempts incomplete labelling without replacing the original failure
 * @param provider provider hosting the workstation
 * @param workstation exact retained workstation
 * @param primary setup failure
 * @returns observed label confirmation
 */
async function recoverIncompleteLabel(
  provider: ProviderDriver,
  workstation: WorkstationRecord,
  primary: Error,
): Promise<'confirmed' | 'unconfirmed'> {
  try {
    await recoverOperation(async () =>
      provider.setMetadata(workstation, {
        setup: 'incomplete',
        version: OPEN_AGENT_VERSION,
      }),
    );

    return 'confirmed';
  } catch (failure) {
    retainRecoveryFailure(primary, 'incomplete label', failure);

    return 'unconfirmed';
  }
}
