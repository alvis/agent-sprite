import { networkDriver } from '#application/catalog/networks';
import { pairAgent } from '#application/catalog/services';
import { commandError } from '#application/failures';
import { requireWorkstationUrl } from '#application/machine';
import {
  ReadinessFault,
  assessReadiness,
  servedVersionMismatch,
} from '#application/readiness';
import { inspectUntilServing } from '#application/serving';
import { agentPort } from '#domain/services';
import { sanitizeGuestDiagnostic } from '#kernel/diagnostics';
import {
  cancellationReason,
  checkOperation,
  currentOperation,
} from '#kernel/operation';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { configureNewWorkstation } from './configuration';
import { withCreateHold } from './hold';
import { createResult, pairingRetry } from './outcome';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { SetupSession } from '#application/ports/session';
import type { CommandResult } from '#application/result';
import type { AgentPairing } from '#domain/declarations';
import type { GuestInspection } from '#domain/observations/inspection';
import type { WorkstationRecord } from '#domain/workstation';

import type { CreateContext } from './context';

interface CreateFinalizationContext {
  workstation: WorkstationRecord;
  guest: GuestChannel;
  observed: GuestInspection;
  context: CreateContext;
  interaction?: Interaction;
}

const PAIRING_REASON_LIMIT = 512;

/** the named inputs of finish create */
export interface FinishCreateParams {
  /** exact newly created provider workstation */
  workstation: WorkstationRecord;
  /** inputs confirmed before creation */
  context: CreateContext;
  /** optional progress boundary */
  interaction?: Interaction;
}

/**
 * configure, verify, expose, and pair one newly created private workstation
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the call's inputs: workstation, context, interaction
 * @returns ready machine and current non-secret guest evidence
 */
export async function finishCreate(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: FinishCreateParams,
): Promise<CommandResult> {
  const { workstation, context, interaction } = params;
  checkOperation();
  const channel = await context.provider.openGuest(workstation);
  const connection = dependencies.guest.session.connect({
    provider: context.provider,
    workstation,
  });

  return withCreateHold(
    dependencies.guest.facts.awakeCommand,
    channel,
    async () => {
      try {
        return await configureAndFinalize(dependencies, {
          workstation,
          context,
          connection,
          interaction,
        });
      } finally {
        await connection.close();
      }
    },
  );
}

/** the named inputs of configure and finalize */
interface ConfigureAndFinalizeParams {
  /** exact newly created provider workstation */
  workstation: WorkstationRecord;
  /** inputs confirmed before creation */
  context: CreateContext;
  /** the workstation's root setup session */
  connection: SetupSession;
  /** optional progress boundary */
  interaction?: Interaction;
}

/**
 * installs and configures the workstation over its setup session, waits for
 * the agent to serve, then verifies, exposes and pairs it
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the call's inputs: workstation, context, connection, interaction
 * @returns ready machine and current non-secret guest evidence
 */
async function configureAndFinalize(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: ConfigureAndFinalizeParams,
): Promise<CommandResult> {
  const { workstation, context } = params;
  const { interaction } = params;
  const guest = await configureNewWorkstation(dependencies, {
    provider: context.provider,
    connection: params.connection,
    interaction,
    configuration: {
      hostname: workstation.name,
      profile: context.input.profile,
      authKey: context.authKey,
      exitNode: context.effectiveExitNode,
      proxyUrl: context.input.proxyUrl,
      proxyApiKey: context.input.proxyApiKey,
      githubToken: context.input.githubToken,
      githubHost: context.options.githubHost,
      gitIdentity: context.input.gitIdentity,
      runtimeEnv: context.input.runtimeEnv,
      setupFile: context.input.setupFile,
      plugins: context.plugins,
    },
  });
  const observed = await inspectUntilServing(
    async () =>
      dependencies.guest.native.inspectAgentEnvironment(
        guest,
        context.input.profile.agent,
      ),
    async () => dependencies.guest.inspection.inspect(guest),
  );

  return finalizeCreate(dependencies, {
    workstation,
    guest,
    observed,
    context,
    interaction,
  });
}

/**
 * verifies and exposes a configured workstation, then handles optional pairing
 * @param dependencies the registered drivers
 * @param finalization real workstation, fresh guest inspection, and create inputs
 * @returns ready machine or a retained ready pairing failure
 */
export async function finalizeCreate(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  finalization: CreateFinalizationContext,
): Promise<CommandResult> {
  const { workstation, observed, context } = finalization;
  assertCreateReadiness(dependencies, observed, context.effectiveExitNode);
  requireWorkstationUrl(workstation);
  await context.provider.expose(
    workstation,
    agentPort(dependencies.registry, context.input.profile.agent),
    'public',
  );
  const ready = await context.provider.setMetadata(workstation, {
    setup: 'ready',
    version: OPEN_AGENT_VERSION,
  });

  return finishReadyCreate(dependencies, {
    ...finalization,
    workstation: ready,
  });
}

/**
 * keeps optional pairing and cancellation after the confirmed READY boundary
 * @param dependencies the registered drivers
 * @param ready workstation returned by the fulfilled READY metadata update and inputs
 * @returns ready result or a retained ready cancellation/failure
 */
async function finishReadyCreate(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  ready: CreateFinalizationContext,
): Promise<CommandResult> {
  const { workstation, guest, observed, context, interaction } = ready;
  let pairing: AgentPairing | undefined;
  let pairingFailure: string | undefined;
  if (context.options.withPairCode) {
    try {
      pairing = await pairAgent(
        dependencies.registry,
        guest,
        context.input.profile.agent,
      );
    } catch (error) {
      const failure = readyError(error);
      if (
        commandError(failure).code === 'CANCELLED' ||
        failure instanceof TypeError ||
        failure instanceof SyntaxError ||
        failure instanceof ReferenceError ||
        failure instanceof RangeError
      ) {
        return readyCreateFailure(dependencies, ready, failure);
      }
      pairingFailure =
        sanitizeGuestDiagnostic(commandError(failure).message).slice(
          -PAIRING_REASON_LIMIT,
        ) || 'Agent pairing could not be completed';
    }
  }
  try {
    checkOperation();
    interaction?.progress({
      stage: 'complete',
      message: `Workstation ${context.name} is ready`,
    });
    const result = createResult(dependencies, {
      workstation,
      observed,
      pairing,
      pairingFailure,
      preflight: context.preflight,
      retainedCredentials: context.input.retainedCredentials,
    });
    checkOperation();

    return result;
  } catch (error) {
    return readyCreateFailure(dependencies, ready, error);
  }
}

/**
 * records an error after READY without demoting the retained machine
 * @param dependencies the registered drivers
 * @param ready confirmed READY workstation and inputs
 * @param error pairing, cancellation or result failure
 * @returns typed retained ready failure with machine identity
 */
function readyCreateFailure(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  ready: CreateFinalizationContext,
  error: unknown,
): CommandResult {
  const { workstation, observed, context } = ready;
  const failure = commandError(readyError(error));

  return {
    command: 'create',
    ok: false,
    data: {
      preflight: context.preflight,
      readiness: assessReadiness(dependencies, observed),
      setup: 'ready',
    },
    error: {
      ...failure,
      outcome: 'retained',
      machine: workstation.name,
      machineId: workstation.id,
      details: [
        ...(failure.details ?? []),
        'The workstation is ready; setup was not demoted.',
        `Pair later: ${pairingRetry(workstation.name)}`,
      ],
    },
  };
}

/**
 * uses the invocation signal when a concurrent abort raced a pairing failure
 * @param error pairing or result failure
 * @returns cancellation when the invocation has aborted, otherwise the failure
 */
function readyError(error: unknown): unknown {
  return currentOperation()?.signal.aborted ? cancellationReason() : error;
}

/**
 * withholds public exposure unless the selected route and every current gate
 * pass, and the agent serves the version installed
 * @param dependencies the registered drivers
 * @param observed fresh guest inspection
 * @param selectedExitNode explicit user exit-node IP or hostname
 * @throws {ReadinessFault} when a gate fails or the agent serves another version than the one installed
 */
function assertCreateReadiness(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  observed: GuestInspection,
  selectedExitNode?: string,
): void {
  const readiness = assessReadiness(dependencies, observed);
  const { failures } = readiness;
  const network = networkDriver(
    dependencies.registry,
    observed.environment.profile.network,
  );
  if (
    selectedExitNode &&
    !network.matchesExitNode(selectedExitNode, observed.network)
  ) {
    failures.push('selected exit node');
  }
  const mismatch = servedVersionMismatch(dependencies, observed);
  if (mismatch) {
    failures.push(mismatch);
  }
  if (failures.length) {
    throw new ReadinessFault({ ...readiness, ready: false });
  }
}
