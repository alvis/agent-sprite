import { commandError, ensureError, retainRecoveryFailure } from '#errors';
import { sanitizeGuestDiagnostic } from '#integrations/guest/diagnostics';
import {
  setManagedSpriteLabels,
  setSpritePrivate,
  SpriteCreationOutcomeError,
  SETUP_INCOMPLETE_LABEL,
} from '#integrations/sprites';
import { InteractionExit } from '#navigation';
import { recoverOperation } from '#operation';
import { ReadinessFault } from '#readiness';
import { redactResolved } from '#utilities/redaction';

import type { Sprite } from '@fly/sprites';

import type { CommandResult } from '#command';

import type { CreateContext, CreatePreflight } from './context.js';
import type { CreatePreparation } from './preparation.js';

const PROVIDER_CAUSE_LIMIT = 512;

/**
 * preserves provider-create failure and its reconciled resource outcome
 * @param error provider creation failure
 * @param preflight verified inputs before the create request
 * @returns structured retained, absent, or unknown outcome
 */
export function creationOutcome(
  error: unknown,
  preflight: CreatePreflight,
): CommandResult {
  if (!(error instanceof SpriteCreationOutcomeError)) {
    throw error;
  }

  const failure = commandError(error.cause);
  const cause = sanitizeGuestDiagnostic(failure.message).slice(
    0,
    PROVIDER_CAUSE_LIMIT,
  );

  return {
    command: 'create',
    ok: false,
    data: { preflight },
    error: {
      code:
        failure.code === 'CANCELLED'
          ? 'CANCELLED'
          : error.outcome === 'absent' || failure.code === 'UNEXPECTED'
            ? 'PROVIDER'
            : failure.code,
      outcome: error.outcome,
      message: redactResolved(error.message),
      machine: error.machine,
      machineId: error.machineId,
      setupIncomplete: error.setupIncomplete,
      details: [
        ...(failure.details ?? []),
        ...(cause ? [`Creation cause: ${cause}`] : []),
        error.outcome === 'retained'
          ? 'The retained Sprite requires setup before use.'
          : error.outcome === 'absent'
            ? 'Provider lookup confirmed this Sprite is absent; creation can be retried.'
            : 'Inspect the provider for a Sprite with this name before retrying.',
      ],
    },
  };
}

/**
 * retains an exact failed Sprite and reports a redacted recovery path
 * @param sprite created Sprite that must remain available for setup
 * @param context inputs that may occur in diagnostic text
 * @param error setup or readiness failure
 * @returns structured incomplete-resource outcome
 */
export async function markCreateIncomplete(
  sprite: Sprite,
  context: CreateContext,
  error: unknown,
): Promise<CommandResult> {
  let primary = ensureError(error);
  const privacy = await recoverOperation(async () =>
    setSpritePrivate(sprite),
  ).then(
    () => 'confirmed' as const,
    (failure: unknown) => {
      primary = retainRecoveryFailure(primary, 'private visibility', failure);

      return 'unconfirmed' as const;
    },
  );
  const incompleteLabel = await recoverOperation(async () =>
    setManagedSpriteLabels(sprite, [SETUP_INCOMPLETE_LABEL]),
  ).then(
    () => 'confirmed' as const,
    (failure: unknown) => {
      primary = retainRecoveryFailure(primary, 'incomplete label', failure);

      return 'unconfirmed' as const;
    },
  );
  const failure = commandError(primary);

  return {
    command: 'create',
    ok: false,
    data: {
      preflight: context.preflight,
      readiness: error instanceof ReadinessFault ? error.readiness : undefined,
      recovery: { privacy, incompleteLabel },
    },
    error: {
      ...failure,
      outcome: 'retained',
      machine: sprite.name,
      machineId: sprite.id,
      setupIncomplete: true,
      details: [
        ...(failure.details ?? []),
        ...(privacy === 'unconfirmed'
          ? [
              'Private URL authentication could not be confirmed; inspect provider visibility.',
            ]
          : []),
        ...(incompleteLabel === 'unconfirmed'
          ? [
              'The incomplete label could not be confirmed; inspect provider state.',
            ]
          : []),
        `Sprite ${sprite.name} was retained. Run agent-sprite setup ${sprite.name} to recover.`,
      ],
    },
  };
}

/**
 * reports typed consent or enrollment failures before Sprite creation
 * @param error consent or enrollment rejection
 * @returns safe preparation failure, preserving local back navigation
 */
export function authorizationFailure(error: unknown): CreatePreparation {
  if (error instanceof InteractionExit && error.action === 'back') {
    throw error;
  }
  const failure = commandError(error);

  return {
    kind: 'result',
    result: {
      command: 'create',
      ok: false,
      error: {
        ...failure,
        message:
          failure.code === 'CANCELLED'
            ? failure.message
            : 'Creation authorization failed; no Sprite was created',
        details: [...(failure.details ?? []), failure.message],
      },
    },
  };
}
