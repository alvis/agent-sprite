import { agentPort } from '#core/services';
import { WorkstationCreationFault } from '#drivers/creation';
import { commandError, ensureError, retainRecoveryFailure } from '#errors';
import { sanitizeGuestDiagnostic } from '#integrations/guest/diagnostics';
import { InteractionExit } from '#navigation';
import { recoverOperation } from '#operation';
import { ReadinessFault } from '#readiness';
import { redactResolved } from '#utilities/redaction';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import type { CommandResult } from '#command';
import type { WorkstationRecord } from '#drivers/contracts';

import type { CreateContext, CreatePreflight } from './context.js';
import type { CreatePreparation } from './preflight.js';

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
  if (!(error instanceof WorkstationCreationFault)) {
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
          ? 'The retained workstation requires setup before use.'
          : error.outcome === 'absent'
            ? 'Provider lookup confirmed this workstation is absent; creation can be retried.'
            : 'Inspect the provider for a workstation with this name before retrying.',
      ],
    },
  };
}

/**
 * retains an exact failed workstation and reports a redacted recovery path
 * @param workstation created workstation that must remain available for setup
 * @param context inputs that may occur in diagnostic text
 * @param error setup or readiness failure
 * @returns structured incomplete-resource outcome
 */
export async function markCreateIncomplete(
  workstation: WorkstationRecord,
  context: CreateContext,
  error: unknown,
): Promise<CommandResult> {
  let primary = ensureError(error);
  const privacy = await recoverOperation(async () =>
    context.provider.expose(
      workstation,
      agentPort(context.input.profile.agent),
      'private',
    ),
  ).then(
    () => 'confirmed' as const,
    (failure: unknown) => {
      primary = retainRecoveryFailure(primary, 'private visibility', failure);

      return 'unconfirmed' as const;
    },
  );
  const incompleteLabel = await recoverOperation(async () =>
    context.provider.setMetadata(workstation, {
      setup: 'incomplete',
      version: OPEN_AGENT_VERSION,
    }),
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
      machine: workstation.name,
      machineId: workstation.id,
      setupIncomplete: true,
      details: [
        ...(failure.details ?? []),
        ...unconfirmedRecovery({ privacy, incompleteLabel }),
        `Workstation ${workstation.name} was retained. Run open-agent setup ${workstation.name} to recover.`,
      ],
    },
  };
}

/**
 * reports typed consent or enrollment failures before workstation creation
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
            : 'Creation authorization failed; no workstation was created',
        details: [...(failure.details ?? []), failure.message],
      },
    },
  };
}

/**
 * explains each recovery step whose outcome could not be confirmed
 * @param recovery whether the private visibility and the incomplete label were confirmed
 * @returns one detail per unconfirmed step
 */
function unconfirmedRecovery(
  recovery: Record<'privacy' | 'incompleteLabel', 'confirmed' | 'unconfirmed'>,
): string[] {
  return [
    ...(recovery.privacy === 'unconfirmed'
      ? [
          'Private URL authentication could not be confirmed; inspect provider visibility.',
        ]
      : []),
    ...(recovery.incompleteLabel === 'unconfirmed'
      ? ['The incomplete label could not be confirmed; inspect provider state.']
      : []),
  ];
}
