import { networkDriver } from '#core/networks';
import { agentPort, pairAgent } from '#core/services';
import { commandError } from '#errors';
import { SetupConnection } from '#integrations/guest/connection';
import { sanitizeGuestDiagnostic } from '#integrations/guest/diagnostics';
import { inspectGuest } from '#integrations/guest/runtime';
import { inspectAgentEnvironment } from '#integrations/native/inspection';
import { requireWorkstationUrl, summarizeMachine } from '#machine';
import {
  cancellationReason,
  checkOperation,
  currentOperation,
} from '#operation';
import { ReadinessFault, assessReadiness } from '#readiness';
import { inspectUntilServing } from '#serving';
import { PairingSecret } from '#utilities/pairing-secret';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import { configureNewWorkstation } from './configure';
import { withCreateHold } from './hold';

import type { CommandResult } from '#command';
import type { Interaction } from '#command/contracts';
import type { AgentPairing, WorkstationRecord } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type {
  CredentialSaveResult,
  ManagementCredentialName,
} from '#integrations/credentials';
import type { GuestInspection } from '#integrations/guest/inspection-types';

import type { CreateContext, CreatePreflight } from './context';

interface ResultContext {
  workstation: WorkstationRecord;
  observed: GuestInspection;
  pairing?: AgentPairing;
  pairingFailure?: string;
  preflight: CreatePreflight;
  retainedCredentials?: Partial<
    Record<ManagementCredentialName, CredentialSaveResult>
  >;
}

interface CreateFinalizationContext {
  workstation: WorkstationRecord;
  guest: GuestChannel;
  observed: GuestInspection;
  context: CreateContext;
  interaction?: Interaction;
}

const PAIRING_REASON_LIMIT = 512;

/**
 * configure, verify, expose, and pair one newly created private workstation
 * @param workstation exact newly created provider workstation
 * @param context inputs confirmed before creation
 * @param interaction optional progress boundary
 * @returns ready machine and current non-secret guest evidence
 */
export async function finishCreate(
  workstation: WorkstationRecord,
  context: CreateContext,
  interaction?: Interaction,
): Promise<CommandResult> {
  checkOperation();
  const channel = await context.provider.openGuest(workstation);
  const connection = new SetupConnection(context.provider, workstation);

  return withCreateHold(channel, async () => {
    try {
      return await configureAndFinalize(workstation, context, {
        connection,
        interaction,
      });
    } finally {
      await connection.close();
    }
  });
}

/**
 * installs and configures the workstation over its setup session, waits for
 * the agent to serve, then verifies, exposes and pairs it
 * @param workstation exact newly created provider workstation
 * @param context inputs confirmed before creation
 * @param session the setup session and the progress boundary
 * @param session.connection the workstation's root setup session
 * @param session.interaction optional progress boundary
 * @returns ready machine and current non-secret guest evidence
 */
async function configureAndFinalize(
  workstation: WorkstationRecord,
  context: CreateContext,
  session: { connection: SetupConnection; interaction?: Interaction },
): Promise<CommandResult> {
  const { interaction } = session;
  const guest = await configureNewWorkstation(context.provider, session, {
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
    plugins: context.plugins,
  });
  const observed = await inspectUntilServing(
    async () => inspectAgentEnvironment(guest, context.input.profile.agent),
    async () => inspectGuest(guest),
  );

  return finalizeCreate({
    workstation,
    guest,
    observed,
    context,
    interaction,
  });
}

/**
 * verifies and exposes a configured workstation, then handles optional pairing
 * @param finalization real workstation, fresh guest inspection, and create inputs
 * @returns ready machine or a retained ready pairing failure
 */
export async function finalizeCreate(
  finalization: CreateFinalizationContext,
): Promise<CommandResult> {
  const { workstation, observed, context } = finalization;
  assertCreateReadiness(observed, context.effectiveExitNode);
  requireWorkstationUrl(workstation);
  await context.provider.expose(
    workstation,
    agentPort(context.input.profile.agent),
    'public',
  );
  const ready = await context.provider.setMetadata(workstation, {
    setup: 'ready',
    version: OPEN_AGENT_VERSION,
  });

  return finishReadyCreate({ ...finalization, workstation: ready });
}

/**
 * keeps optional pairing and cancellation after the confirmed READY boundary
 * @param ready workstation returned by the fulfilled READY metadata update and inputs
 * @returns ready result or a retained ready cancellation/failure
 */
async function finishReadyCreate(
  ready: CreateFinalizationContext,
): Promise<CommandResult> {
  const { workstation, guest, observed, context, interaction } = ready;
  let pairing: AgentPairing | undefined;
  let pairingFailure: string | undefined;
  if (context.options.withPairCode) {
    try {
      pairing = await pairAgent(guest, context.input.profile.agent);
    } catch (error) {
      const failure = readyError(error);
      if (
        commandError(failure).code === 'CANCELLED' ||
        failure instanceof TypeError ||
        failure instanceof SyntaxError ||
        failure instanceof ReferenceError ||
        failure instanceof RangeError
      ) {
        return readyCreateFailure(ready, failure);
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
    const result = createResult({
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
    return readyCreateFailure(ready, error);
  }
}

/**
 * records an error after READY without demoting the retained machine
 * @param ready confirmed READY workstation and inputs
 * @param error pairing, cancellation or result failure
 * @returns typed retained ready failure with machine identity
 */
function readyCreateFailure(
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
      readiness: assessReadiness(observed),
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
 * names the explicit command that can mint another pairing code
 * @param name confirmed READY workstation name
 * @returns retry command with a quoted workstation name
 */
function pairingRetry(name: string): string {
  return `open-agent show ${JSON.stringify(name)} --with-pair-code`;
}

/**
 * withholds public exposure unless the selected route and every current gate pass
 * @param observed fresh guest inspection
 * @param selectedExitNode explicit user exit-node IP or hostname
 */
function assertCreateReadiness(
  observed: GuestInspection,
  selectedExitNode?: string,
): void {
  const readiness = assessReadiness(observed);
  const { failures } = readiness;
  const network = networkDriver(observed.environment.profile.network);
  if (
    selectedExitNode &&
    !network.matchesExitNode(selectedExitNode, observed.network)
  ) {
    failures.push('selected exit node');
  }
  if (failures.length) {
    throw new ReadinessFault({ ...readiness, ready: false });
  }
}

/**
 * returns a successful create with pairing only after an explicit request
 * @param context ready workstation, guest evidence, and optional pairing
 * @returns final structured create result
 */
function createResult(context: ResultContext): CommandResult {
  const {
    workstation,
    observed,
    pairing,
    pairingFailure,
    preflight,
    retainedCredentials,
  } = context;

  return {
    command: 'create',
    ok: true,
    data: {
      machine: summarizeMachine(
        workstation,
        pairing ? new PairingSecret({ token: pairing.token }) : undefined,
      ),
      preflight,
      retainedCredentials,
      profile: observed.environment.profile,
      readiness: assessReadiness(observed),
      network: {
        deviceId: observed.network.deviceId,
        exitNode: observed.network.exitNode,
        exitNodeIp: observed.network.exitNodeIp,
        online: observed.network.online,
        routeDevice: observed.network.routeDevice,
        dnsReady: observed.network.dnsReady,
        egressIp: observed.network.egressIp,
        skipped: observed.network.skipped,
        reason: observed.network.reason,
      },
      hub: observed.hub,
      services: observed.services.map((service) => ({
        name: service.name,
        state: service.status,
      })),
      native: observed.native,
      pairing: pairing
        ? {
            status: 'created',
            expiresAt: pairing.expiresAt,
            token: new PairingSecret({ token: pairing.token }),
          }
        : pairingFailure
          ? {
              status: 'failed',
              reason: pairingFailure,
              retry: pairingRetry(workstation.name),
            }
          : { status: 'not requested' },
    },
  };
}
