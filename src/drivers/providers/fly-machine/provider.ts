import { ProviderFault } from '#drivers/failures';
import { checkOperation, currentOperation } from '#operation';
import { rememberSecret } from '#utilities/redaction';

import { FlyApi } from './api.js';
import { flyBootHookStep } from './boot-hook-step.js';
import { inspectFlyBoot, startAndBoot, waitForBoot } from './boot.js';
import { FlyGuestChannel } from './channel.js';
import { createManagedApp } from './creation.js';
import { waitUntilDeleted } from './deletion.js';
import { deriveSshToken } from './flyctl.js';
import { flyMachineGuestLeaf } from './guest-leaf.js';
import { declaresAgentService, FLY_MACHINE_IMAGES } from './machine-config.js';
import { FLY_MACHINES } from './machines.js';
import { metadataUpdate } from './metadata.js';
import {
  FLY_MACHINE_PREREQUISITES,
  preflightFlyMachine,
} from './prerequisites.js';
import { isLive, isManaged, toRecord, workstationMachine } from './records.js';
import { configuredRegion } from './region.js';
import { resizeMachine } from './resize.js';
import { isAccessDenied } from './status.js';
import { PUBLIC_IP_TYPES } from './wire.js';

import type { WorkstationProfile } from '#core/profile';
import type {
  ExposureVisibility,
  MachineOffer,
  PrerequisiteProblem,
  ProfileIncompatibility,
  ProviderBinding,
  ProviderDriver,
  ProviderPreflightParams,
  WorkstationMetadata,
  WorkstationRecord,
} from '#drivers/contracts';
import type { GuestChannel, GuestProcess } from '#drivers/guest-channel';

import type { FlyApp, FlyMachine } from './wire.js';

/** live provider state shared by every record one bound driver returns */
interface FlySession {
  /** Machines API client bound to the organization token */
  api: FlyApi;
  /** organization token, from which each app's SSH token is derived */
  token: string;
  /** region new workstations are placed in; the nearest when absent */
  region: string | undefined;
  /** organization the token manages, resolved once */
  organization?: Promise<string>;
  /** SSH-scoped token of each app, derived once and kept in memory only */
  sshTokens: Map<string, Promise<string>>;
  /** one channel per workstation identity */
  channels: Map<string, FlyGuestChannel>;
}

/** an app verified to be an open-agent workstation */
interface VerifiedWorkstation {
  /** the app */
  app: FlyApp;
  /** its single managed machine */
  machine: FlyMachine;
  /** organization owning it */
  organization: string;
}

/** Fly Machines as a provider driver: one app, machine and volume per workstation */
export class FlyMachineProvider implements ProviderDriver<'fly-machine'> {
  public readonly id = 'fly-machine';
  public readonly kind = 'providers';
  public readonly displayName = 'Fly Machine';
  public readonly capabilities = flyMachineGuestLeaf.capabilities;
  public readonly machines = FLY_MACHINES;
  // the spec implies no driver combination a Fly Machine cannot host
  public readonly incompatibilities: readonly ProfileIncompatibility[] = [];
  public readonly prerequisites = FLY_MACHINE_PREREQUISITES;
  public readonly shellAccounts = flyMachineGuestLeaf.shellAccounts;
  public readonly images = FLY_MACHINE_IMAGES;
  public readonly serviceBackend = flyMachineGuestLeaf.serviceBackend;
  public readonly bootHookStep = flyBootHookStep;
  public readonly bootHook = flyMachineGuestLeaf.bootHook;
  public readonly inspectBoot = inspectFlyBoot;
  public readonly awakeAdapter = flyMachineGuestLeaf.awakeAdapter;
  public readonly awakeAsset = flyMachineGuestLeaf.awakeAsset;
  readonly #session?: FlySession;

  /**
   * binds the driver to an optional provider session
   * @param session authenticated session; absent for the catalog declaration
   */
  constructor(session?: FlySession) {
    this.#session = session;
  }

  /**
   * checks flyctl and the organization token offline before any provider call
   * @param params resolved credential and host tool lookup
   * @returns every missing or misconfigured prerequisite with its fix
   */
  public async preflight(
    params: ProviderPreflightParams,
  ): Promise<PrerequisiteProblem[]> {
    return preflightFlyMachine(params);
  }

  /**
   * binds an organization token
   * @param binding organization token; Fly restores no services itself
   * @returns a driver bound to the token
   */
  public authenticate(binding: ProviderBinding): FlyMachineProvider {
    rememberSecret(binding.credential);

    return new FlyMachineProvider({
      api: new FlyApi(binding.credential),
      token: binding.credential,
      region: configuredRegion(),
      sshTokens: new Map(),
      channels: new Map(),
    });
  }

  /**
   * lists the organization's workstations without waking any: one record per
   * app whose live machines are exactly one managed machine, as get verifies
   * @returns current managed workstations
   */
  public async list(): Promise<WorkstationRecord[]> {
    const { api } = this.#bound();
    const organization = await this.#organization();
    const machines = await api.listOrganizationMachines(organization);
    const byApp = Map.groupBy(machines.filter(isLive), ({ app }) => app);

    return [...byApp].flatMap(([app, held]) => {
      const [machine, ...others] = held;

      return machine && others.length === 0 && isManaged(machine)
        ? [toRecord(app, organization, machine)]
        : [];
    });
  }

  /**
   * fetches and verifies a managed workstation without waking it
   * @param name workstation name
   * @returns verified managed workstation
   */
  public async get(name: string): Promise<WorkstationRecord> {
    const { machine, organization } = await this.#fetchVerified(name);

    return toRecord(name, organization, machine);
  }

  /**
   * tells whether an app already uses a name in the organization; app names
   * are global, so a name another Fly account holds is refused as a conflict
   * @param name proposed workstation name
   * @returns true when creating the name would collide
   * @throws {ProviderFault} conflict when another Fly account holds the name
   */
  public async isNameTaken(name: string): Promise<boolean> {
    return this.#bound()
      .api.hasApp(name)
      .catch(async (error: unknown) => {
        if (!isAccessDenied(error)) {
          throw error;
        }
        // a token the API refuses fails this call too, as authentication
        await this.#organization();
        throw new ProviderFault({
          code: 'conflict',
          message: `Fly app name ${name} is already used by another Fly account; choose a different name`,
          cause: error,
        });
      });
  }

  /**
   * creates one private app with a volume and a started machine
   * @param name workstation name, used as the app name
   * @param profile validated profile
   * @param port ACP agent port a later exposure publishes
   * @returns created private workstation
   */
  public async create(
    name: string,
    profile: WorkstationProfile,
    port: number,
  ): Promise<WorkstationRecord> {
    const { api, region } = this.#bound();
    const organization = await this.#organization();
    const machine = await createManagedApp({
      api,
      name,
      organization,
      region: region ?? (await api.nearestRegion()),
      profile,
      port,
    });

    return toRecord(name, organization, machine);
  }

  /**
   * revalidates the immutable identity, then destroys the app with its
   * machine and volume and waits until the app is gone
   * @param workstation previously reviewed workstation
   */
  public async delete(workstation: WorkstationRecord): Promise<void> {
    const { api } = this.#bound();
    const { name } = workstation;
    await this.#fetchMatching(workstation);
    await api.deleteApp(name);
    await waitUntilDeleted(api, name);
    this.#bound().channels.delete(workstation.id);
  }

  /**
   * records setup state and profile summary as machine metadata keys, which
   * neither restarts nor wakes the machine
   * @param workstation managed workstation
   * @param metadata setup state and optional profile summary to record
   * @returns the workstation as recorded after the update
   */
  public async setMetadata(
    workstation: WorkstationRecord,
    metadata: WorkstationMetadata,
  ): Promise<WorkstationRecord> {
    const { api } = this.#bound();
    const { machine } = await this.#fetchMatching(workstation);
    await api.updateMetadata(
      { app: workstation.name, machine: machine.id },
      metadataUpdate(metadata),
    );

    return this.get(workstation.name);
  }

  /**
   * moves the machine to a size by updating only its guest, which restarts it;
   * a machine already on the size is left alone. The guest channel of the
   * replaced run is dropped, so the next one opens against the new run
   * @param workstation managed workstation
   * @param offer machine size to run on
   * @returns the workstation as recorded after the change
   */
  public async resize(
    workstation: WorkstationRecord,
    offer: MachineOffer,
  ): Promise<WorkstationRecord> {
    const { api, channels } = this.#bound();
    const { machine, organization } = await this.#fetchMatching(workstation);
    const resized = await resizeMachine({
      api,
      app: workstation.name,
      machine,
      offer,
    });
    if (resized !== machine) {
      channels.delete(workstation.id);
    }

    return toRecord(workstation.name, organization, resized);
  }

  /**
   * attaches or detaches the public addresses the Fly proxy routes to the
   * service declared at creation; changing the service itself would restart
   * the machine, so exposure only assigns or releases the app's addresses
   * @param workstation managed workstation
   * @param port ACP agent port the declared service routes
   * @param visibility who may reach the URL
   */
  public async expose(
    workstation: WorkstationRecord,
    port: number,
    visibility: ExposureVisibility,
  ): Promise<void> {
    const { api } = this.#bound();
    const { name } = workstation;
    const { machine } = await this.#fetchMatching(workstation);
    const assigned = await api.listIps(name);
    if (visibility === 'private') {
      for (const { ip, type } of assigned) {
        if (PUBLIC_IP_TYPES.has(type)) {
          await api.releaseIp(name, ip);
        }
      }

      return;
    }
    if (!declaresAgentService(machine.routes, port)) {
      throw new ProviderFault({
        code: 'failed',
        message: `Fly machine of ${name} declares no auto-starting service for port ${port}`,
      });
    }
    if (!assigned.some(({ type }) => type === 'v6')) {
      await api.assignIp(name, 'v6');
    }
    if (!assigned.some(({ type }) => type === 'shared_v4')) {
      await api.assignIp(name, 'shared_v4');
    }
  }

  /**
   * opens the guest channel, starting a stopped or suspended machine first;
   * a machine already starting, or one whose start conflicts with a start
   * under way, is only waited for; either way the channel opens only once
   * the boot script has rebuilt the root filesystem from the volume
   * @param workstation managed workstation
   * @returns the guest channel
   */
  public async openGuest(
    workstation: WorkstationRecord,
  ): Promise<GuestChannel> {
    const { api, channels } = this.#bound();
    const existing = channels.get(workstation.id);
    if (existing) {
      return existing;
    }
    const { app, machine } = await this.#fetchMatching(workstation);
    await startAndBoot(api, { app: app.name, machine: machine.id }, machine);
    const channel = new FlyGuestChannel({
      api,
      app: app.name,
      machine: machine.id,
      sshToken: async () => this.#sshToken(app),
    });
    channels.set(workstation.id, channel);

    return channel;
  }

  /**
   * opens a root shell over `fly ssh console`, which logs in as root
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
   * waits until the boot script has rebuilt the root filesystem in the
   * machine's current boot
   * @param workstation managed workstation, already started
   */
  public async awaitGuestReady(workstation: WorkstationRecord): Promise<void> {
    const { app, machine } = await this.#fetchMatching(workstation);
    await waitForBoot(this.#bound().api, {
      app: app.name,
      machine: machine.id,
    });
  }

  /**
   * requires a bound credential before any provider call
   * @returns the authenticated session
   */
  #bound(): FlySession {
    if (!this.#session) {
      throw new ProviderFault({
        code: 'authentication',
        message: `${FLY_MACHINE_PREREQUISITES.credential.environment} is required.`,
      });
    }

    return this.#session;
  }

  /**
   * resolves, once per session, the organization the token manages
   * @returns organization slug
   */
  async #organization(): Promise<string> {
    const session = this.#bound();
    session.organization ??= session.api.organization();

    return session.organization.catch((error: unknown) => {
      session.organization = undefined;
      throw error;
    });
  }

  /**
   * derives, once per session, the SSH token of one app
   * @param app the workstation app
   * @returns the SSH-scoped token
   */
  async #sshToken(app: FlyApp): Promise<string> {
    const session = this.#bound();
    const known = session.sshTokens.get(app.id);
    if (known) {
      return known;
    }
    const derived = deriveSshToken(session.token, app.numericId);
    session.sshTokens.set(app.id, derived);

    return derived.catch((error: unknown) => {
      session.sshTokens.delete(app.id);
      throw error;
    });
  }

  /**
   * fetches a workstation and requires its immutable identity and
   * organization to match a previously observed record
   * @param workstation previously observed workstation
   * @returns the verified workstation
   */
  async #fetchMatching(
    workstation: WorkstationRecord,
  ): Promise<VerifiedWorkstation> {
    const verified = await this.#fetchVerified(workstation.name);
    if (
      verified.machine.id !== workstation.id ||
      verified.organization !== workstation.organization
    ) {
      throw new ProviderFault({
        code: 'ownership-mismatch',
        message: `Fly app ${workstation.name} changed identity or organization`,
      });
    }

    return verified;
  }

  /**
   * fetches an app and requires it to be an open-agent workstation of the
   * token's organization
   * @param name workstation name
   * @returns the verified workstation
   */
  async #fetchVerified(name: string): Promise<VerifiedWorkstation> {
    const { api } = this.#bound();
    const operation = currentOperation();
    checkOperation(operation);
    const [app, machines, organization] = await Promise.all([
      api.getApp(name),
      api.listMachines(name),
      this.#organization(),
    ]);
    if (app.organization !== organization) {
      throw new ProviderFault({
        code: 'ownership-mismatch',
        message: `Fly app ${name} does not belong to organization ${organization}`,
      });
    }
    const machine = workstationMachine(name, machines);
    operation?.identify({ name, id: machine.id });
    checkOperation(operation);

    return { app, machine, organization };
  }
}

/** the unbound Fly Machine provider registered in the catalog */
export const flyMachine = new FlyMachineProvider();
