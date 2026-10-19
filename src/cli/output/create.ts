import { projectRetainedCredentials } from './credentials';
import { each, projectFields, same } from './fields';
import {
  projectHub,
  projectNative,
  projectNetworkStatus,
  projectServiceSummary,
} from './inspection';
import { projectMachine } from './machine';
import { projectPairing } from './pairing';
import { projectProfile } from './profile';
import { projectReadiness } from './readiness';

import type { CreatePreflight } from '#application/create/context';
import type { CreateData, CreateFailureData } from '#application/data';

import type { RetainedCredentialsOutput } from './credentials';
import type {
  HubOutput,
  NativeOutput,
  NetworkOutput,
  ServiceSummaryOutput,
} from './inspection';
import type { MachineOutput } from './machine';
import type { PairingOutput } from './pairing';
import type { ProfileOutput } from './profile';
import type { ReadinessOutput } from './readiness';

/** checks that passed and reminders raised before creation */
export interface PreflightOutput {
  checks: readonly string[];
  reminders: readonly string[];
}

/** a created workstation with verified preflight and current guest evidence */
export interface CreateDataOutput {
  retainedCredentials?: RetainedCredentialsOutput;
  machine: MachineOutput;
  preflight: PreflightOutput;
  profile: ProfileOutput;
  readiness: ReadinessOutput;
  network: NetworkOutput;
  hub: HubOutput;
  services: ServiceSummaryOutput[];
  native?: NativeOutput;
  pairing: PairingOutput;
}

/** what a failed creation still verified */
export interface CreateFailureDataOutput {
  preflight: PreflightOutput;
  readiness?: ReadinessOutput;
  setup?: 'ready';
  recovery?: {
    privacy: 'confirmed' | 'unconfirmed';
    incompleteLabel: 'confirmed' | 'unconfirmed';
  };
}

/**
 * projects the preflight facts
 * @param preflight internal preflight
 * @returns output preflight
 */
export function projectPreflight(preflight: CreatePreflight): PreflightOutput {
  return projectFields<CreatePreflight, PreflightOutput>(preflight, {
    checks: same,
    reminders: same,
  });
}

/**
 * projects a successful creation
 * @param data internal creation result
 * @returns output creation result
 */
export function projectCreate(data: CreateData): CreateDataOutput {
  return projectFields<CreateData, CreateDataOutput>(data, {
    retainedCredentials: projectRetainedCredentials,
    machine: projectMachine,
    preflight: projectPreflight,
    profile: projectProfile,
    readiness: projectReadiness,
    network: projectNetworkStatus,
    hub: projectHub,
    services: each(projectServiceSummary),
    native: projectNative,
    pairing: projectPairing,
  });
}

/**
 * projects what a failed creation still verified
 * @param data internal failure observations
 * @returns output failure observations
 */
export function projectCreateFailure(
  data: CreateFailureData,
): CreateFailureDataOutput {
  return projectFields<CreateFailureData, CreateFailureDataOutput>(data, {
    preflight: projectPreflight,
    readiness: projectReadiness,
    setup: same,
    recovery: (recovery) =>
      projectFields<
        typeof recovery,
        NonNullable<CreateFailureDataOutput['recovery']>
      >(recovery, { privacy: same, incompleteLabel: same }),
  });
}
