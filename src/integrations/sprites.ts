import { APIError, SpritesClient } from '@fly/sprites';

import { CommandFault } from '#errors';
import {
  checkOperation,
  recoverOperation,
  currentOperation,
  cancellationReason,
  runOperation,
} from '#operation';

import type { Sprite } from '@fly/sprites';

/** exact previously reviewed provider identity required for deletion */
export interface DeleteManagedSpriteParams {
  name: string;
  expectedId: string;
  expectedOrganization: string;
}

/** provider observation and original error associated with a failed create */
export interface SpriteCreationOutcomeParams {
  machine: string;
  machineId?: string;
  outcome: 'retained' | 'absent' | 'unknown';
  cause: unknown;
}

/** identifies managed Sprites */
export const MANAGED_LABEL = 'agent-sprite';
/** identifies the compact control-plane schema */
export const SCHEMA_LABEL = 'agent-sprite-schema-v1';
/** marks a completed current provisioning attempt */
export const SETUP_READY_LABEL = 'agent-sprite-setup-ready';
/** marks a machine that needs a targeted setup retry */
export const SETUP_INCOMPLETE_LABEL = 'agent-sprite-setup-incomplete';
const NOT_FOUND_STATUS = 404;

/** represents a create failure reconciled against the live provider name */
export class SpriteCreationOutcomeError extends Error {
  public readonly machine: string;
  public readonly machineId?: string;
  public readonly setupIncomplete?: true;
  public readonly outcome: SpriteCreationOutcomeParams['outcome'];

  /**
   * records the observed provider state after a failed create request
   * @param params observed create outcome
   */
  constructor(params: SpriteCreationOutcomeParams) {
    const retained = params.outcome === 'retained';
    super(
      retained
        ? `Sprite creation failed after ${params.machine} became visible; ` +
            'a managed resource was retained and setup is incomplete'
        : params.outcome === 'absent'
          ? `Sprite creation for ${params.machine} failed; provider lookup confirmed no Sprite with this name`
          : `Sprite creation for ${params.machine} failed with an unknown outcome; ` +
            'inspect provider state before retrying',
      { cause: params.cause },
    );
    this.name = 'SpriteCreationOutcomeError';
    this.machine = params.machine;
    this.machineId = params.machineId;
    this.setupIncomplete = retained ? true : undefined;
    this.outcome = params.outcome;
  }
}

/**
 * creates an authenticated provider client with bounded requests
 * @param token Sprites API credential
 * @returns authenticated provider client
 */
export function createSpritesClient(token: string): SpritesClient {
  return new SpritesClient(token, { timeout: 30_000 });
}

/**
 * lists every managed Sprite from the live paginated provider API
 * @param client authenticated provider client
 * @returns current managed Sprites
 */
export async function listManagedSprites(
  client: SpritesClient,
): Promise<Sprite[]> {
  const sprites = await runOperation(async () => client.listAllSprites());

  return sprites.filter((sprite) => sprite.labels.includes(MANAGED_LABEL));
}

/**
 * fetches and verifies a managed Sprite before inspection or mutation
 * @param client authenticated provider client
 * @param name requested Sprite name
 * @returns verified managed Sprite
 */
export async function getManagedSprite(
  client: SpritesClient,
  name: string,
): Promise<Sprite> {
  const operation = currentOperation();
  checkOperation(operation);
  const sprite = await client.getSprite(name).catch((error: unknown) => {
    checkOperation(operation);
    throw error;
  });
  if (
    !sprite.id ||
    !sprite.organizationName ||
    !sprite.labels.includes(MANAGED_LABEL)
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Sprite ${name} is not a verified agent-sprite workstation`,
    });
  }

  operation?.identify({ name: sprite.name, id: sprite.id });
  checkOperation(operation);

  return sprite;
}

/**
 * creates one privately routed, labelled Sprite
 * @param client authenticated provider client
 * @param name requested Sprite name
 * @returns created private Sprite
 */
export async function createManagedSprite(
  client: SpritesClient,
  name: string,
): Promise<Sprite> {
  const operation = currentOperation();
  checkOperation(operation);
  operation?.identify({ name });
  let created: Sprite | undefined;
  try {
    created = await client.createSprite(name, {
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
      urlSettings: { auth: 'sprite' },
    });
    operation?.identify({ name: created.name, id: created.id });

    return created;
  } catch (error) {
    const cause = operation?.signal.aborted ? cancellationReason() : error;
    if (created) {
      throw new SpriteCreationOutcomeError({
        machine: created.name,
        machineId: created.id,
        outcome: 'retained',
        cause,
      });
    }
    let observed: Sprite;
    try {
      observed = await recoverOperation(async () =>
        runOperation(async () => client.getSprite(name)),
      );
    } catch (lookupError) {
      throw new SpriteCreationOutcomeError({
        machine: name,
        outcome:
          lookupError instanceof APIError &&
          lookupError.statusCode === NOT_FOUND_STATUS
            ? 'absent'
            : 'unknown',
        cause,
      });
    }
    throw new SpriteCreationOutcomeError({
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
}

/**
 * revalidates the immutable identity before permanent deletion
 * @param client authenticated provider client
 * @param params requested name and previously observed immutable identity
 */
export async function deleteManagedSprite(
  client: SpritesClient,
  params: DeleteManagedSpriteParams,
): Promise<void> {
  const { name, expectedId, expectedOrganization } = params;
  const sprite = await getManagedSprite(client, name);
  if (
    sprite.id !== expectedId ||
    sprite.organizationName !== expectedOrganization
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Sprite ${name} changed identity or organization before deletion`,
    });
  }
  const operation = currentOperation();
  checkOperation(operation);
  await client.deleteSprite(name).catch((error: unknown) => {
    checkOperation(operation);
    throw error;
  });
}

/**
 * merges owned labels without disturbing labels installed by other systems
 * @param sprite managed Sprite to update
 * @param labels owned labels to apply
 * @returns updated Sprite
 */
export async function setManagedSpriteLabels(
  sprite: Sprite,
  labels: string[],
): Promise<Sprite> {
  if (!sprite.labels.includes(MANAGED_LABEL)) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Sprite ${sprite.name} is not managed by agent-sprite`,
    });
  }
  const existingLabels = sprite.labels.filter(
    (label) => label !== SETUP_READY_LABEL && label !== SETUP_INCOMPLETE_LABEL,
  );

  return runOperation(async () =>
    sprite.update({
      labels: [...new Set([...existingLabels, ...labels])],
    }),
  );
}

/**
 * enables only the provider URL after T3 has been configured
 * @param sprite managed Sprite to expose
 */
export async function setSpritePublic(sprite: Sprite): Promise<void> {
  await setSpriteVisibility(sprite, 'public');
}

/**
 * restores provider authentication before an incomplete creation is retained
 * @param sprite managed Sprite whose public exposure is unconfirmed
 */
export async function setSpritePrivate(sprite: Sprite): Promise<void> {
  await setSpriteVisibility(sprite, 'sprite');
}

/**
 * applies the exact provider URL authentication mode for a managed Sprite
 * @param sprite managed Sprite to update
 * @param auth provider URL authentication mode
 */
async function setSpriteVisibility(
  sprite: Sprite,
  auth: 'public' | 'sprite',
): Promise<void> {
  if (!sprite.labels.includes(MANAGED_LABEL)) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Sprite ${sprite.name} is not managed by agent-sprite`,
    });
  }
  await runOperation(async () => sprite.updateURLSettings({ auth }));
}

/**
 * returns the canonical provider URL or fails rather than inventing one
 * @param sprite Sprite with a provider URL
 * @returns canonical provider URL
 */
export function getSpriteUrl(sprite: Sprite): string {
  if (!sprite.url) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Sprite ${sprite.name} has no provider URL`,
    });
  }

  return sprite.url;
}
