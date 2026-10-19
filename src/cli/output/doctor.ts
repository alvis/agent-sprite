import { projectEnvironment } from './environment';
import { each, projectFields, same } from './fields';
import {
  projectBoot,
  projectGovernor,
  projectHub,
  projectNative,
  projectNetworkStatus,
  projectServiceSummary,
  projectUpdates,
} from './inspection';
import { projectMachine } from './machine';
import { projectProbeFailure } from './readiness';

import type { CurrentReadiness, DoctorData } from '#application/data';

import type { EnvironmentOutput } from './environment';
import type {
  BootOutput,
  GovernorOutput,
  HubOutput,
  NativeOutput,
  NetworkOutput,
  ServiceSummaryOutput,
  UpdateStatusOutput,
} from './inspection';
import type { MachineOutput } from './machine';
import type { ProbeFailureOutput } from './readiness';

/** readiness evidence retained even when the workstation is not ready */
export interface CurrentReadinessOutput {
  ready: boolean;
  failures: readonly string[];
  skipped: readonly string[];
  probeFailures: ProbeFailureOutput[];
  network: NetworkOutput;
  hub: HubOutput;
  native?: NativeOutput;
  services: ServiceSummaryOutput[];
  environment: EnvironmentOutput;
  updates?: UpdateStatusOutput;
  governor: GovernorOutput;
  boot?: BootOutput;
}

/** the bounded doctor inspection */
export interface DoctorDataOutput {
  machine: MachineOutput;
  currentReadiness: CurrentReadinessOutput;
}

/**
 * projects readiness with the evidence behind it
 * @param readiness internal readiness
 * @returns output readiness
 */
function projectCurrentReadiness(
  readiness: CurrentReadiness,
): CurrentReadinessOutput {
  return projectFields<CurrentReadiness, CurrentReadinessOutput>(readiness, {
    ready: same,
    failures: same,
    skipped: same,
    probeFailures: each(projectProbeFailure),
    network: projectNetworkStatus,
    hub: projectHub,
    native: projectNative,
    services: each(projectServiceSummary),
    environment: projectEnvironment,
    updates: projectUpdates,
    governor: projectGovernor,
    boot: projectBoot,
  });
}

/**
 * projects the doctor result
 * @param data internal result
 * @returns output result
 */
export function projectDoctor(data: DoctorData): DoctorDataOutput {
  return projectFields<DoctorData, DoctorDataOutput>(data, {
    machine: projectMachine,
    currentReadiness: projectCurrentReadiness,
  });
}
