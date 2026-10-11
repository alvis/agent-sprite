import { commandError, ensureError, retainRecoveryFailure } from '#errors';
import {
  setManagedSpriteLabels,
  SETUP_INCOMPLETE_LABEL,
} from '#integrations/sprites';
import { InteractionExit } from '#navigation';
import { recoverOperation } from '#operation';
import { ReadinessFault } from '#readiness';

import type { Sprite } from '@fly/sprites';

import type { CommandResult } from '#command';
import type { SetupSection } from '#command/contracts';

import type { SetupProgress } from './context.js';

interface SetupFailureParams {
  sprite: Sprite;
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
  const { sprite, mutation, section } = params;
  const error =
    params.error instanceof InteractionExit &&
    params.error.action === 'back' &&
    mutation.started
      ? new InteractionExit('cancel')
      : params.error;
  const primary = ensureError(error);
  const incompleteLabel = mutation.started
    ? await recoverIncompleteLabel(sprite, primary)
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
      machine: sprite.name,
      machineId: sprite.id,
      setupIncomplete: mutation.started ? true : undefined,
      details: [
        ...(failure.details ?? []),
        ...(incompleteLabel === 'unconfirmed'
          ? [
              'The incomplete label could not be confirmed; inspect provider state.',
            ]
          : []),
        ...(section
          ? [
              `Failed setup section: ${section}`,
              `Retry: agent-sprite setup ${JSON.stringify(sprite.name)} --section ${section}`,
            ]
          : []),
      ],
    },
  };
}

/**
 * attempts incomplete labelling without replacing the original failure
 * @param sprite exact retained workstation
 * @param primary setup failure
 * @returns observed label confirmation
 */
async function recoverIncompleteLabel(
  sprite: Sprite,
  primary: Error,
): Promise<'confirmed' | 'unconfirmed'> {
  try {
    await recoverOperation(async () =>
      setManagedSpriteLabels(sprite, [SETUP_INCOMPLETE_LABEL]),
    );

    return 'confirmed';
  } catch (failure) {
    retainRecoveryFailure(primary, 'incomplete label', failure);

    return 'unconfirmed';
  }
}
