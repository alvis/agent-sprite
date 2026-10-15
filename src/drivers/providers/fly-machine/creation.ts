import { WorkstationCreationFault } from '#drivers/creation';
import { ProviderFault } from '#drivers/failures';
import { pickMachine } from '#drivers/machine-sizes';
import { summarizeProfile } from '#drivers/providers/recorded';
import {
  cancellationReason,
  checkOperation,
  currentOperation,
  recoverOperation,
} from '#operation';

import { machineSpec, VOLUME_NAME, VOLUME_SIZE_GB } from './machine-config.js';
import { FLY_MACHINES } from './machines.js';
import { creationMetadata } from './metadata.js';
import { isNotFound } from './status.js';

import type { WorkstationProfile } from '#core/profile';
import type { CreationOutcome } from '#drivers/creation';

import type { FlyApi } from './api.js';
import type { FlyMachineOffer } from './machines.js';
import type { FlyMachine } from './wire.js';

/** one create request and where it is placed */
export interface CreateAppParams {
  /** authenticated Machines API client */
  api: FlyApi;
  /** app name, which is the workstation name */
  name: string;
  /** organization the app is created in */
  organization: string;
  /** region of the volume and machine */
  region: string;
  /** validated profile whose summary is recorded */
  profile: WorkstationProfile;
  /** ACP agent port a later exposure publishes */
  port: number;
}

/** how far one create got before it failed */
interface CreationAttempt {
  /** authenticated Machines API client */
  api: FlyApi;
  /** app name */
  name: string;
  /** whether this create made the app */
  appCreated: boolean;
}

/** longest the API holds a request open while the machine starts */
const START_WAIT_SECONDS = 60;

/**
 * creates one app holding one volume and one started machine, labelled with
 * ownership and the profile summary; the app has no public address, so it
 * stays private until exposure. A failure after the app exists removes it
 * again, so a failed create leaves nothing behind or reports what remains
 * @param params client, name, placement, profile and port
 * @returns the started machine
 */
export async function createManagedApp(
  params: CreateAppParams,
): Promise<FlyMachine> {
  const { api, name, organization, region, profile, port } = params;
  const machine = requireOffer(profile);
  const operation = currentOperation();
  checkOperation(operation);
  operation?.identify({ name });
  try {
    await api.createApp(name, organization);
  } catch (error) {
    const cause = operation?.signal.aborted ? cancellationReason() : error;
    throw await reconcileCreation({ api, name, appCreated: false }, cause);
  }
  try {
    const volume = await api.createVolume(name, {
      name: VOLUME_NAME,
      region,
      sizeGb: VOLUME_SIZE_GB,
    });
    const created = await api.createMachine(name, {
      name,
      region,
      spec: machineSpec({
        machine,
        volume,
        port,
        metadata: creationMetadata(summarizeProfile(profile)),
      }),
    });
    operation?.identify({ name, id: created.id });
    await api.waitUntilStarted(
      { app: name, machine: created.id },
      START_WAIT_SECONDS,
    );

    return { ...created, state: 'started' };
  } catch (error) {
    const cause = operation?.signal.aborted ? cancellationReason() : error;
    throw await reconcileCreation({ api, name, appCreated: true }, cause);
  }
}

/**
 * picks the smallest Fly preset that meets the profile's minimums
 * @param profile validated profile
 * @returns the preset the machine runs on
 * @throws {ProviderFault} when no preset meets the minimums
 */
function requireOffer(profile: WorkstationProfile): FlyMachineOffer {
  const { minCpus, minMemoryGb } = profile.options;
  const offer = pickMachine(FLY_MACHINES, {
    cpus: minCpus,
    memoryGb: minMemoryGb,
  });
  if (!offer) {
    throw new ProviderFault({
      code: 'failed',
      message: `Fly offers no machine with ${String(minCpus)} CPUs and ${String(minMemoryGb)} GB`,
    });
  }

  return offer;
}

/**
 * removes an app this create made, then looks the name up again to report
 * what a failed create left behind
 * @param attempt client, app name and whether this create made the app
 * @param cause original create failure
 * @returns the reconciled creation failure
 */
async function reconcileCreation(
  attempt: CreationAttempt,
  cause: unknown,
): Promise<WorkstationCreationFault> {
  const { api, name } = attempt;
  // an app name is global, so a conflict is an app this create never made
  if (cause instanceof ProviderFault && cause.code === 'conflict') {
    return new WorkstationCreationFault({
      machine: name,
      outcome: 'absent',
      cause,
      message: `Fly app name ${name} is already taken, possibly by another organization; no app was created`,
    });
  }
  try {
    const present = await recoverOperation(async () => {
      if (attempt.appCreated) {
        await api.deleteApp(name).catch((error: unknown) => {
          if (!isNotFound(error)) {
            throw error;
          }
        });
      }

      return api.hasApp(name);
    });

    return creationFault({
      machine: name,
      outcome: present ? 'unknown' : 'absent',
      cause,
    });
  } catch {
    return creationFault({ machine: name, outcome: 'unknown', cause });
  }
}

/**
 * describes one reconciled outcome
 * @param params observed outcome, name and original failure
 * @param params.machine requested app name
 * @param params.outcome reconciled provider state
 * @param params.cause original create failure
 * @returns the creation failure
 */
function creationFault(params: {
  machine: string;
  outcome: CreationOutcome;
  cause: unknown;
}): WorkstationCreationFault {
  const { machine, outcome } = params;
  const message =
    outcome === 'absent'
      ? `Fly app creation for ${machine} failed; provider lookup confirmed no app with this name remains`
      : `Fly app creation for ${machine} failed with an unknown outcome; ` +
        'inspect provider state before retrying';

  return new WorkstationCreationFault({ ...params, message });
}
