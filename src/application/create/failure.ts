import { commandError } from '#application/failures';
import { ReadinessFault } from '#application/readiness';
import { WorkstationCreationFault } from '#domain/creation';
import { agentPort } from '#domain/services';
import { sanitizeGuestDiagnostic } from '#kernel/diagnostics';
import { ensureError, retainRecoveryFailure } from '#kernel/faults';
import { InteractionExit } from '#kernel/navigation';
import { recoverOperation } from '#kernel/operation';
import { redactResolved } from '#kernel/redaction';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { CommandResult } from '#application/result';
import type { WorkstationRecord } from '#domain/workstation';

import type {
  CreateContext,
  CreatePreflight,
  CreatePreparation,
} from './context';

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

/** the named inputs of mark create incomplete */
export interface MarkCreateIncompleteParams {
  /** created workstation that must remain available for setup */
  workstation: WorkstationRecord;
  /** inputs that may occur in diagnostic text */
  context: CreateContext;
  /** setup or readiness failure */
  error: unknown;
}

/**
 * retains an exact failed workstation and reports a redacted recovery path
 * @param dependencies the registered drivers
 * @param params the call's inputs: workstation, context, error
 * @returns structured incomplete-resource outcome
 */
export async function markCreateIncomplete(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: MarkCreateIncompleteParams,
): Promise<CommandResult> {
  const { workstation, context, error } = params;
  let primary = ensureError(error);
  const privacy = await recoverOperation(async () =>
    context.provider.expose(
      workstation,
      agentPort(dependencies.registry, context.input.profile.agent),
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
