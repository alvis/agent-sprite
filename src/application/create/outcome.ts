import { summarizeMachine } from '#application/machine';
import { assessReadiness } from '#application/readiness';
import { PairingSecret } from '#kernel/pairing-secret';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { CommandResult } from '#application/result';
import type {
  CredentialSaveResult,
  ManagementCredentialName,
} from '#domain/credentials';
import type { AgentPairing } from '#domain/declarations';
import type { GuestInspection } from '#domain/observations/inspection';
import type { WorkstationRecord } from '#domain/workstation';

import type { CreatePreflight } from './context';

/** what the successful create result reports */
export interface ResultContext {
  workstation: WorkstationRecord;
  observed: GuestInspection;
  pairing?: AgentPairing;
  pairingFailure?: string;
  preflight: CreatePreflight;
  retainedCredentials?: Partial<
    Record<ManagementCredentialName, CredentialSaveResult>
  >;
}

/**
 * names the explicit command that can mint another pairing code
 * @param name confirmed READY workstation name
 * @returns retry command with a quoted workstation name
 */
export function pairingRetry(name: string): string {
  return `open-agent show ${JSON.stringify(name)} --with-pair-code`;
}

/**
 * returns a successful create with pairing only after an explicit request
 * @param dependencies the registered drivers
 * @param context ready workstation, guest evidence, and optional pairing
 * @returns final structured create result
 */
export function createResult(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  context: ResultContext,
): CommandResult {
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
        dependencies,
        workstation,
        pairing ? new PairingSecret({ token: pairing.token }) : undefined,
      ),
      preflight,
      retainedCredentials,
      profile: observed.environment.profile,
      readiness: assessReadiness(dependencies, observed),
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
