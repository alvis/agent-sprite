import { SpritesClient } from '@fly/sprites';

import { ProviderFault } from '#drivers/failures';
import { guestAsset } from '#integrations/guest/assets';
import { checkOperation, currentOperation, runOperation } from '#operation';
import { SHARED_MODE } from '#os/contracts';

import { SPRITE_CAPABILITIES } from './capabilities.js';
import { SpriteGuestChannel } from './channel.js';
import { createManagedSprite } from './creation.js';
import { callSprites, toProviderFailure } from './failures.js';
import { mergeMetadataLabels } from './labels.js';
import { SPRITE_MACHINE } from './machines.js';
import { preflightSprite, SPRITE_PREREQUISITES } from './prerequisites.js';
import {
  assertManaged,
  assertVerifiedWorkstation,
  isManaged,
  toRecord,
} from './records.js';

import type { Sprite } from '@fly/sprites';

import type { WorkstationProfile } from '#core/profile';
import type {
  ExposureVisibility,
  MachineOffer,
  PrerequisiteProblem,
  ProfileIncompatibility,
  ProviderBinding,
  ProviderDriver,
  ProviderPreflightParams,
  ProviderPrerequisites,
  WorkstationMetadata,
  WorkstationRecord,
} from '#drivers/contracts';
import type { GuestChannel, GuestProcess } from '#drivers/guest-channel';
import type { OsImage } from '#os/contracts';

const REQUEST_TIMEOUT_MS = 30_000;

/** live provider state shared by every record one bound driver returns */
export interface SpriteSession {
  /** authenticated provider client */
  client: SpritesClient;
  /** SDK object behind each record this driver returned */
  sprites: WeakMap<WorkstationRecord, Sprite>;
  /** one channel per workstation identity, so guest transactions are shared */
  channels: Map<string, SpriteGuestChannel>;
  /** managed services the channels may stop and restore around a replacement */
  restorableServices: readonly string[];
}

/** Fly Sprites as a provider driver */
export class SpriteProvider implements ProviderDriver<'sprite'> {
  public readonly id = 'sprite';
  public readonly kind = 'providers';
  public readonly displayName = 'Fly Sprite';
  public readonly capabilities = SPRITE_CAPABILITIES;
  public readonly machines: readonly MachineOffer[] = [SPRITE_MACHINE];
  public readonly incompatibilities: readonly ProfileIncompatibility[] = [];
  public readonly prerequisites: ProviderPrerequisites = SPRITE_PREREQUISITES;
  // the Sprite login account receives the same GitHub CLI login as the agent
  public readonly shellAccounts: readonly string[] = ['sprite'];
  // a Sprite boots one image Fly picks and names neither its release nor its
  // architecture, so only the guest probe tells them; its tooling is Debian's
  public readonly images: readonly [OsImage, ...OsImage[]] = [
    { id: 'sprite', family: 'debian', arch: ['x86_64', 'aarch64'] },
  ];
  // a Sprite runs its services itself
  public readonly serviceBackend = 'provider';
  // the governor applies deadlines as the agent, so the agent runs the adapter
  public readonly awakeAsset = guestAsset(
    'drivers/providers/sprite/awake.sh',
    SHARED_MODE,
  );
  readonly #session?: SpriteSession;

  /**
   * binds the driver to an optional provider session
   * @param session authenticated session; absent for the catalog declaration
   */
  constructor(session?: SpriteSession) {
    this.#session = session;
  }

  /**
   * checks the Sprites token offline before any provider call
   * @param params resolved credential and host tool lookup
   * @returns every missing or misconfigured prerequisite with its fix
   */
  public async preflight(
    params: ProviderPreflightParams,
  ): Promise<PrerequisiteProblem[]> {
    return preflightSprite(params);
  }

  /**
   * binds a Sprites API token with bounded requests
   * @param binding Sprites API token and the services core may restore
   * @returns a driver bound to the token
   */
  public authenticate(binding: ProviderBinding): SpriteProvider {
    return new SpriteProvider({
      client: new SpritesClient(binding.credential, {
        timeout: REQUEST_TIMEOUT_MS,
      }),
      sprites: new WeakMap(),
      channels: new Map(),
      restorableServices: [...binding.restorableServices],
    });
  }

  /**
   * lists every managed Sprite from the live paginated provider API
   * @returns current managed workstations
   */
  public async list(): Promise<WorkstationRecord[]> {
    const session = this.#bound();
    const sprites = await runOperation(async () =>
      callSprites(async () => session.client.listAllSprites()),
    );

    return sprites.filter(isManaged).map((sprite) => this.#record(sprite));
  }

  /**
   * fetches and verifies a managed Sprite before inspection or mutation
   * @param name requested Sprite name
   * @returns verified managed workstation
   */
  public async get(name: string): Promise<WorkstationRecord> {
    return this.#record(await this.#fetchVerified(name));
  }

  /**
   * tells whether any Sprite, managed or not, already uses a name
   * @param name proposed Sprite name
   * @returns true when creating the name would collide
   */
  public async isNameTaken(name: string): Promise<boolean> {
    const { client } = this.#bound();
    const sprites = await runOperation(async () =>
      callSprites(async () => client.listAllSprites()),
    );

    return sprites.some((sprite) => sprite.name === name);
  }

  /**
   * creates one privately routed Sprite labelled with ownership and profile summary
   * @param name requested Sprite name
   * @param profile validated profile
   * @returns created private workstation
   */
  public async create(
    name: string,
    profile: WorkstationProfile,
  ): Promise<WorkstationRecord> {
    const { client } = this.#bound();

    return this.#record(await createManagedSprite({ client, name, profile }));
  }

  /**
   * revalidates the immutable identity before permanent deletion
   * @param workstation previously reviewed workstation
   */
  public async delete(workstation: WorkstationRecord): Promise<void> {
    const { client } = this.#bound();
    const { name } = workstation;
    const sprite = await this.#fetchVerified(name);
    if (
      sprite.id !== workstation.id ||
      sprite.organizationName !== workstation.organization
    ) {
      throw new ProviderFault({
        code: 'ownership-mismatch',
        message: `Sprite ${name} changed identity or organization before deletion`,
      });
    }
    const operation = currentOperation();
    checkOperation(operation);
    await client.deleteSprite(name).catch((error: unknown) => {
      checkOperation(operation);
      throw toProviderFailure(error);
    });
  }

  /**
   * merges owned labels without disturbing labels installed by other systems
   * @param workstation managed workstation
   * @param metadata setup state and optional profile summary to record
   * @returns the workstation as labelled after the update
   */
  public async setMetadata(
    workstation: WorkstationRecord,
    metadata: WorkstationMetadata,
  ): Promise<WorkstationRecord> {
    const sprite = await this.#sprite(workstation);
    assertManaged(sprite);
    const updated = await runOperation(async () =>
      callSprites(async () =>
        sprite.update({ labels: mergeMetadataLabels(sprite.labels, metadata) }),
      ),
    );

    return this.#record(updated);
  }

  /**
   * applies the provider URL authentication mode; the URL routes the one
   * HTTP port the agent service registered, so the port needs no setting here
   * @param workstation managed workstation
   * @param _port ACP agent port, already routed by its service definition
   * @param visibility who may reach the URL
   */
  public async expose(
    workstation: WorkstationRecord,
    _port: number,
    visibility: ExposureVisibility,
  ): Promise<void> {
    const sprite = await this.#sprite(workstation);
    assertManaged(sprite);
    await runOperation(async () =>
      callSprites(async () =>
        sprite.updateURLSettings({
          auth: visibility === 'public' ? 'public' : 'sprite',
        }),
      ),
    );
  }

  /**
   * leaves the workstation as it is: a Sprite has one size and configures none
   * @param workstation managed workstation
   * @returns the same workstation
   */
  public async resize(
    workstation: WorkstationRecord,
  ): Promise<WorkstationRecord> {
    return workstation;
  }

  /**
   * opens the guest channel, sharing one channel per workstation identity
   * @param workstation managed workstation
   * @returns the guest channel
   */
  public async openGuest(
    workstation: WorkstationRecord,
  ): Promise<GuestChannel> {
    const { channels, restorableServices } = this.#bound();
    const existing = channels.get(workstation.id);
    if (existing) {
      return existing;
    }
    const channel = new SpriteGuestChannel({
      sprite: await this.#sprite(workstation),
      restorableServices,
    });
    channels.set(workstation.id, channel);

    return channel;
  }

  /**
   * opens a root shell over the exec API, behind `sudo -n` as every privileged Sprite command is
   * @param workstation managed workstation
   * @param shell absolute path of the OS family's shell
   * @returns the running shell
   */
  public async openRootShell(
    workstation: WorkstationRecord,
    shell: string,
  ): Promise<GuestProcess> {
    const guest = await this.openGuest(workstation);

    return guest.spawn({ program: shell, arguments: [] });
  }

  /**
   * a Sprite wakes on its first exec and runs no boot script of open-agent's,
   * so there is nothing to wait for
   * @param _workstation managed workstation
   */
  public async awaitGuestReady(_workstation: WorkstationRecord): Promise<void> {
    // the Sprite exec API waits for a sleeping Sprite to wake itself
  }

  /**
   * requires a bound credential before any provider call
   * @returns the authenticated session
   */
  #bound(): SpriteSession {
    if (!this.#session) {
      throw new ProviderFault({
        code: 'authentication',
        message: 'SPRITES_TOKEN is required.',
      });
    }

    return this.#session;
  }

  /**
   * records the SDK object behind a returned workstation
   * @param sprite freshly observed Sprite
   * @returns the workstation record
   */
  #record(sprite: Sprite): WorkstationRecord {
    const record = toRecord(sprite);
    this.#bound().sprites.set(record, sprite);

    return record;
  }

  /**
   * resolves the SDK object behind a record, refetching one this driver did
   * not return and rejecting when its immutable identity no longer matches
   * @param workstation managed workstation
   * @returns the Sprite behind the record
   */
  async #sprite(workstation: WorkstationRecord): Promise<Sprite> {
    const known = this.#bound().sprites.get(workstation);
    if (known) {
      return known;
    }
    const sprite = await this.#fetchVerified(workstation.name);
    if (sprite.id !== workstation.id) {
      throw new ProviderFault({
        code: 'ownership-mismatch',
        message: `Sprite ${workstation.name} changed identity`,
      });
    }

    return sprite;
  }

  /**
   * fetches a Sprite and requires immutable identity and ownership
   * @param name requested Sprite name
   * @returns verified managed Sprite
   */
  async #fetchVerified(name: string): Promise<Sprite> {
    const { client } = this.#bound();
    const operation = currentOperation();
    checkOperation(operation);
    const sprite = await client.getSprite(name).catch((error: unknown) => {
      checkOperation(operation);
      throw toProviderFailure(error);
    });
    assertVerifiedWorkstation(sprite, name);
    operation?.identify({ name: sprite.name, id: sprite.id });
    checkOperation(operation);

    return sprite;
  }
}

/** the unbound Sprite provider registered in the catalog */
export const sprite = new SpriteProvider();
