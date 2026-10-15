import { WorkstationCreationFault } from '#drivers/creation';
import { summarizeProfile } from '#drivers/providers/recorded';
import {
  cancellationReason,
  checkOperation,
  currentOperation,
  recoverOperation,
  runOperation,
} from '#operation';

import { isSpriteAbsent, toProviderFailure } from './failures.js';
import { MANAGED_LABEL, profileSummaryLabels, SCHEMA_LABEL } from './labels.js';

import type { Sprite, SpritesClient } from '@fly/sprites';

import type { WorkstationProfile } from '#core/profile';
import type { CreationOutcome } from '#drivers/creation';

/** one create request and the client issuing it */
export interface CreateSpriteParams {
  /** authenticated provider client */
  client: SpritesClient;
  /** requested Sprite name */
  name: string;
  /** validated profile whose summary is recorded */
  profile: WorkstationProfile;
}

/**
 * creates one privately routed Sprite labelled with ownership and profile summary
 * @param params client, requested name and profile
 * @returns created private Sprite
 */
export async function createManagedSprite(
  params: CreateSpriteParams,
): Promise<Sprite> {
  const { client, name, profile } = params;
  const operation = currentOperation();
  checkOperation(operation);
  operation?.identify({ name });
  let created: Sprite | undefined;
  try {
    created = await client.createSprite(name, {
      labels: [
        MANAGED_LABEL,
        SCHEMA_LABEL,
        ...profileSummaryLabels(summarizeProfile(profile)),
      ],
      urlSettings: { auth: 'sprite' },
    });
    operation?.identify({ name: created.name, id: created.id });

    return created;
  } catch (error) {
    const cause = operation?.signal.aborted
      ? cancellationReason()
      : toProviderFailure(error);
    if (created) {
      throw creationFault({
        machine: created.name,
        machineId: created.id,
        outcome: 'retained',
        cause,
      });
    }
    throw await reconcileCreation(client, name, cause);
  }
}

/**
 * looks the requested name up again to report what a failed create left behind
 * @param client authenticated provider client
 * @param name requested Sprite name
 * @param cause original create failure
 * @returns the reconciled creation failure
 */
async function reconcileCreation(
  client: SpritesClient,
  name: string,
  cause: unknown,
): Promise<WorkstationCreationFault> {
  let observed: Sprite;
  try {
    observed = await recoverOperation(async () =>
      runOperation(async () => client.getSprite(name)),
    );
  } catch (lookupError) {
    return creationFault({
      machine: name,
      outcome: isSpriteAbsent(lookupError) ? 'absent' : 'unknown',
      cause,
    });
  }

  return creationFault({
    machine: name,
    machineId: observed.id,
    outcome:
      observed.labels.includes(MANAGED_LABEL) &&
      observed.labels.includes(SCHEMA_LABEL)
        ? 'retained'
        : 'unknown',
    cause,
  });
}

/**
 * describes one reconciled outcome with the Sprite diagnostics users see
 * @param params observed outcome, identity and original failure
 * @param params.machine requested or observed Sprite name
 * @param params.machineId immutable identity, when observed
 * @param params.outcome reconciled provider state
 * @param params.cause original create failure
 * @returns the creation failure
 */
function creationFault(params: {
  machine: string;
  machineId?: string;
  outcome: CreationOutcome;
  cause: unknown;
}): WorkstationCreationFault {
  const { machine, outcome } = params;
  const message =
    outcome === 'retained'
      ? `Sprite creation failed after ${machine} became visible; ` +
        'a managed resource was retained and setup is incomplete'
      : outcome === 'absent'
        ? `Sprite creation for ${machine} failed; provider lookup confirmed no Sprite with this name`
        : `Sprite creation for ${machine} failed with an unknown outcome; ` +
          'inspect provider state before retrying';

  return new WorkstationCreationFault({ ...params, message });
}
