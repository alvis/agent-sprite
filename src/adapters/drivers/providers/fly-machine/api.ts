import { ProviderFault } from '#kernel/provider-fault';

import { isNotFound } from './status';
import { flyRequest } from './transport';

import {
  parseApp,
  parseExec,
  parseIps,
  parseMachine,
  parseMachineConfig,
  parseMachinePage,
  parseMachines,
  parseNearestRegion,
  parseTokenOrganizations,
  parseVolumeId,
  wireGuest,
  wireMachineConfig,
} from './wire';

import type { MachineSpec } from './machine-config';
import type { FlyRequest } from './transport';
import type {
  FlyApp,
  FlyExecResult,
  FlyGuest,
  FlyIpAssignment,
  FlyMachine,
  FlyOrgMachine,
} from './wire';

/** one machine of one app */
export interface FlyMachineTarget {
  /** app name */
  app: string;
  /** machine identity */
  machine: string;
}

/** where and how large a new volume is */
interface FlyVolumeRequest {
  /** volume name */
  name: string;
  /** region code */
  region: string;
  /** size in gigabytes */
  sizeGb: number;
}

/** where a new machine runs and what it runs */
interface FlyMachineRequest {
  /** machine name */
  name: string;
  /** region code */
  region: string;
  /** machine description */
  spec: MachineSpec;
}

const API_TIMEOUT_MS = 30_000;
/** longest the API holds a request open while a resized machine restarts */
const UPDATE_WAIT_SECONDS = 60;
const MILLISECONDS_PER_SECOND = 1_000;
/** how the API words a refused app name that another organization already holds */
const NAME_TAKEN = /taken/iu;
/** the token prefix the Machines API expects; organization tokens carry it already */
const MACAROON_SCHEME = 'FlyV1 ';

/** the Fly Machines REST API, authenticated by one organization token */
export class FlyApi {
  readonly #authorization: string;

  /**
   * binds the client to a management token
   * @param token Fly organization token, with or without its scheme prefix
   */
  constructor(token: string) {
    const trimmed = token.trim();
    this.#authorization = trimmed.startsWith(MACAROON_SCHEME)
      ? trimmed
      : `${MACAROON_SCHEME}${trimmed}`;
  }

  /**
   * names the organization the token manages
   * @returns organization slug
   */
  public async organization(): Promise<string> {
    const [slug, ...others] = parseTokenOrganizations(
      await this.#request({ method: 'GET', path: '/tokens/current' }),
    );
    if (!slug || others.some((other) => other !== slug)) {
      throw new ProviderFault({
        code: 'authentication',
        message:
          'The Fly token does not name exactly one organization; use an organization token',
      });
    }

    return slug;
  }

  /**
   * names the region nearest this computer
   * @returns region code
   */
  public async nearestRegion(): Promise<string> {
    const nearest = parseNearestRegion(
      await this.#request({ method: 'GET', path: '/platform/regions' }),
    );
    if (!nearest) {
      throw new ProviderFault({
        code: 'failed',
        message: 'The Fly Machines API reported no nearest region',
      });
    }

    return nearest;
  }

  /**
   * fetches one app
   * @param app name of the workstation app
   * @returns its identity, numeric identity and organization
   */
  public async getApp(app: string): Promise<FlyApp> {
    return parseApp(
      await this.#request({ method: 'GET', path: `/apps/${encode(app)}` }),
    );
  }

  /**
   * tells whether an app exists, without treating its absence as a failure
   * @param app name of the workstation app
   * @returns true while the app exists
   */
  public async hasApp(app: string): Promise<boolean> {
    return this.getApp(app).then(
      () => true,
      (error: unknown) => {
        if (isNotFound(error)) {
          return false;
        }
        throw error;
      },
    );
  }

  /**
   * creates an empty app in an organization
   * @param app name of the workstation app
   * @param organization organization slug
   */
  public async createApp(app: string, organization: string): Promise<void> {
    await this.#request({
      method: 'POST',
      path: '/apps',
      body: { name: app, org_slug: organization },
    }).catch((error: unknown) => {
      // app names are global, so a name held elsewhere is refused as invalid
      throw error instanceof ProviderFault &&
        error.code === 'failed' &&
        NAME_TAKEN.test(error.message)
        ? new ProviderFault({
            code: 'conflict',
            message: error.message,
            cause: error,
          })
        : error;
    });
  }

  /**
   * destroys an app with its machines and volumes
   * @param app name of the workstation app
   */
  public async deleteApp(app: string): Promise<void> {
    await this.#request({ method: 'DELETE', path: `/apps/${encode(app)}` });
  }

  /**
   * creates a volume
   * @param app name of the workstation app
   * @param volume volume name, region and size
   * @returns the volume identity
   */
  public async createVolume(
    app: string,
    volume: FlyVolumeRequest,
  ): Promise<string> {
    return parseVolumeId(
      await this.#request({
        method: 'POST',
        path: `/apps/${encode(app)}/volumes`,
        body: {
          name: volume.name,
          region: volume.region,
          size_gb: volume.sizeGb,
        },
      }),
    );
  }

  /**
   * creates and launches a machine
   * @param app name of the workstation app
   * @param machine machine name, region and description
   * @returns the launched machine as the API first reports it
   */
  public async createMachine(
    app: string,
    machine: FlyMachineRequest,
  ): Promise<FlyMachine> {
    return parseMachine(
      await this.#request({
        method: 'POST',
        path: `/apps/${encode(app)}/machines`,
        body: {
          name: machine.name,
          region: machine.region,
          config: wireMachineConfig(machine.spec),
        },
      }),
    );
  }

  /**
   * lists every machine of an app
   * @param app name of the workstation app
   * @returns every machine the app holds
   */
  public async listMachines(app: string): Promise<FlyMachine[]> {
    return parseMachines(
      await this.#request({
        method: 'GET',
        path: `/apps/${encode(app)}/machines`,
      }),
    );
  }

  /**
   * lists every machine of an organization without waking any of them
   * @param organization organization slug
   * @returns every machine of the organization with its app
   */
  public async listOrganizationMachines(
    organization: string,
  ): Promise<FlyOrgMachine[]> {
    const machines: FlyOrgMachine[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams(cursor ? { cursor } : {});
      const page = parseMachinePage(
        await this.#request({
          method: 'GET',
          path: `/orgs/${encode(organization)}/machines?${query.toString()}`,
        }),
      );
      if (page.errorRegions.length > 0) {
        throw new ProviderFault({
          code: 'transient',
          message: `Fly could not list machines in ${page.errorRegions.join(', ')}`,
        });
      }
      machines.push(...page.machines);
      cursor = page.nextCursor;
    } while (cursor);

    return machines;
  }

  /**
   * starts a stopped or suspended machine
   * @param target app and machine
   */
  public async startMachine(target: FlyMachineTarget): Promise<void> {
    await this.#request({
      method: 'POST',
      path: `${machinePath(target)}/start`,
    });
  }

  /**
   * waits until a machine has started
   * @param target app and machine
   * @param timeoutSeconds longest wait the API holds the request open
   * @param instanceId run of the machine to wait for, so a run that is being
   * replaced is not mistaken for the new one; any run when absent
   */
  public async waitUntilStarted(
    target: FlyMachineTarget,
    timeoutSeconds: number,
    instanceId?: string,
  ): Promise<void> {
    const query = new URLSearchParams({
      state: 'started',
      timeout: String(timeoutSeconds),
    });
    if (instanceId) {
      query.set('instance_id', instanceId);
    }
    await this.#request({
      method: 'GET',
      path: `${machinePath(target)}/wait?${query.toString()}`,
      timeoutMs: API_TIMEOUT_MS + timeoutSeconds * MILLISECONDS_PER_SECOND,
    });
  }

  /**
   * changes the CPUs and memory of a machine, which restarts it. The machine's
   * current configuration is read and posted back whole with only the guest
   * CPU kind, CPUs and memory replaced, so every other setting survives: files,
   * services, mounts, init, metadata, restart policy and any other guest key
   * @param target app and machine
   * @param guest CPUs and memory to run on
   * @returns the machine as the API reports it after the update
   */
  public async updateMachine(
    target: FlyMachineTarget,
    guest: FlyGuest,
  ): Promise<FlyMachine> {
    const current = parseMachineConfig(
      await this.#request({ method: 'GET', path: machinePath(target) }),
    );
    const updated = parseMachine(
      await this.#request({
        method: 'POST',
        path: machinePath(target),
        body: {
          config: {
            ...current.config,
            guest: { ...current.guest, ...wireGuest(guest) },
          },
          current_version: current.instanceId,
        },
      }),
    );
    // an update boots a machine that was stopped or suspended, and replaces the
    // run of a running one, so the wait names the run the update created
    await this.waitUntilStarted(
      target,
      UPDATE_WAIT_SECONDS,
      updated.instanceId,
    );

    return updated;
  }

  /**
   * sets and removes metadata keys without restarting the machine; an empty
   * value removes its key and keys not named are left untouched
   * @param target app and machine
   * @param metadata keys to set, or to remove with an empty value
   */
  public async updateMetadata(
    target: FlyMachineTarget,
    metadata: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#request({
      method: 'PATCH',
      path: `${machinePath(target)}/metadata`,
      body: { metadata },
    });
  }

  /**
   * runs a short command without standard input and buffers its output
   * @param target app and machine
   * @param command program and arguments
   * @param timeoutSeconds longest run the guest allows
   * @returns exit status and output
   */
  public async exec(
    target: FlyMachineTarget,
    command: readonly string[],
    timeoutSeconds: number,
  ): Promise<FlyExecResult> {
    return parseExec(
      await this.#request({
        method: 'POST',
        path: `${machinePath(target)}/exec`,
        body: { command, timeout: timeoutSeconds },
        timeoutMs: API_TIMEOUT_MS + timeoutSeconds * MILLISECONDS_PER_SECOND,
      }),
    );
  }

  /**
   * lists the addresses assigned to an app
   * @param app name of the workstation app
   * @returns the assignments
   */
  public async listIps(app: string): Promise<FlyIpAssignment[]> {
    return parseIps(
      await this.#request({
        method: 'GET',
        path: `/apps/${encode(app)}/ip_assignments`,
      }),
    );
  }

  /**
   * assigns a public address to an app
   * @param app name of the workstation app
   * @param type a dedicated IPv6 or a shared IPv4 address
   */
  public async assignIp(app: string, type: 'v6' | 'shared_v4'): Promise<void> {
    await this.#request({
      method: 'POST',
      path: `/apps/${encode(app)}/ip_assignments`,
      body: { type },
    });
  }

  /**
   * releases one public address of an app
   * @param app name of the workstation app
   * @param ip assigned address
   */
  public async releaseIp(app: string, ip: string): Promise<void> {
    await this.#request({
      method: 'DELETE',
      path: `/apps/${encode(app)}/ip_assignments/${encode(ip)}`,
    });
  }

  /**
   * sends one request with the organization token
   * @param request method, path, body and timeout
   * @returns the decoded body, or undefined for an empty one
   */
  async #request(request: FlyRequest): Promise<unknown> {
    return flyRequest(this.#authorization, request);
  }
}

/**
 * builds the API path of one machine
 * @param target app and machine
 * @returns absolute API path below the base URL
 */
function machinePath(target: FlyMachineTarget): string {
  return `/apps/${encode(target.app)}/machines/${encode(target.machine)}`;
}

/**
 * escapes one path segment
 * @param segment app name, machine identity or address
 * @returns the encoded segment
 */
function encode(segment: string): string {
  return encodeURIComponent(segment);
}
