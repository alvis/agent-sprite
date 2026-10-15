import { registeredSummary } from '#core/profile';

import { CommandFault } from './errors.js';

import type { ProfileSummary } from '#core/profile';
import type {
  MachineOffer,
  WorkstationRecord,
  WorkstationSetupState,
} from '#drivers/contracts';

import type { PairingSecret } from '#utilities/pairing-secret';

const DNS_LABEL_MAX_LENGTH = 63;

/** control-plane details only; guest state is never inferred from this projection */
export interface MachineSummary {
  id: string;
  name: string;
  organization: string;
  createdAt?: string;
  state: string;
  /** machine size the provider reports; absent when it reports none */
  machine?: MachineOffer;
  agentUrl?: string | PairingSecret;
  setup: WorkstationSetupState;
  /** driver selection recorded in provider metadata; absent when unrecorded */
  profile?: ProfileSummary;
  readiness: 'not inspected';
}

/**
 * explains why a user-selected hostname cannot name a workstation
 * @param name requested DNS-compatible machine name
 * @returns the problem, or undefined for a valid name
 */
export function machineNameProblem(name: string): string | undefined {
  return name.length > DNS_LABEL_MAX_LENGTH ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
    ? 'Workstation name must be a lowercase DNS label of at most 63 characters'
    : undefined;
}

/**
 * validates a user-selected hostname before provisioning
 * @param name requested DNS-compatible machine name
 */
export function validateMachineName(name: string): void {
  const problem = machineNameProblem(name);
  if (problem) {
    throw new CommandFault({ code: 'INPUT', message: problem });
  }
}

/**
 * converts a live provider record into control-plane data with optional pairing consent
 * @param workstation freshly fetched provider record
 * @param pairingCode explicitly disclosed native agent pairing code to attach to its normal URL
 * @returns a control-plane summary with guest readiness marked uninspected
 */
export function summarizeMachine(
  workstation: WorkstationRecord,
  pairingCode?: PairingSecret,
): MachineSummary {
  if (!workstation.id || !workstation.organization) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Workstation ${workstation.name} lacks immutable provider identity`,
    });
  }

  return {
    id: workstation.id,
    name: workstation.name,
    organization: workstation.organization,
    createdAt: workstation.createdAt,
    state: workstation.state,
    machine: workstation.machine,
    agentUrl: workstation.url
      ? pairingCode
        ? pairingCode.forUrl(workstation.url)
        : workstation.url
      : undefined,
    setup: workstation.metadata.setup,
    profile: registeredSummary(workstation.metadata.profile),
    readiness: 'not inspected',
  };
}

/**
 * returns the canonical provider URL or fails rather than inventing one
 * @param workstation workstation with a provider URL
 * @returns canonical provider URL
 */
export function requireWorkstationUrl(workstation: WorkstationRecord): string {
  if (!workstation.url) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Workstation ${workstation.name} has no provider URL`,
    });
  }

  return workstation.url;
}
