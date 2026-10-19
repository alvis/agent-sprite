import { projectEnvironment } from './environment';
import { each, projectFields, same } from './fields';
import {
  projectBoot,
  projectGovernor,
  projectGuestService,
  projectHub,
  projectNative,
  projectNetworkStatus,
  projectUpdates,
} from './inspection';
import { projectMachine } from './machine';
import { projectPairing } from './pairing';
import { projectProbeFailure, projectReadiness } from './readiness';

import type { ShowData } from '#application/data';

import type { InspectionOutput } from './inspection';
import type { MachineOutput } from './machine';
import type { PairingOutput } from './pairing';
import type { ReadinessOutput } from './readiness';

/** the guest evidence an inspection requested, with optional readiness */
export interface ShowInspectionOutput extends InspectionOutput {
  readiness?: ReadinessOutput;
}

/** the selected workstation and any inspection or local action requested */
export interface ShowDataOutput {
  machine: MachineOutput;
  inspection?: ShowInspectionOutput;
  pairing?: PairingOutput;
  action?: 'copy';
}

type ShownInspection = NonNullable<ShowData['inspection']>;

/**
 * projects the requested inspection
 * @param inspection internal inspection with optional readiness
 * @returns output inspection
 */
function projectShownInspection(
  inspection: ShownInspection,
): ShowInspectionOutput {
  return projectFields<ShownInspection, ShowInspectionOutput>(inspection, {
    services: each(projectGuestService),
    network: projectNetworkStatus,
    native: projectNative,
    hub: projectHub,
    environment: projectEnvironment,
    updates: projectUpdates,
    probeFailures: each(projectProbeFailure),
    governor: projectGovernor,
    boot: projectBoot,
    readiness: projectReadiness,
  });
}

/**
 * projects the show result
 * @param data internal result
 * @returns output result
 */
export function projectShow(data: ShowData): ShowDataOutput {
  return projectFields<ShowData, ShowDataOutput>(data, {
    machine: projectMachine,
    inspection: projectShownInspection,
    pairing: projectPairing,
    action: same,
  });
}
