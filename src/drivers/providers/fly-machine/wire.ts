import { ProviderFault } from '#drivers/failures';
import { isRecord } from '#utilities/guards';

import { PRIVATE_V6_PREFIX } from './private-networks.js';

import type { MachineSpec } from './machine-config.js';

/** a Fly app, validated from the Machines API */
export interface FlyApp {
  /** immutable app identity */
  id: string;
  /** app name, which is also the workstation name */
  name: string;
  /** numeric identity the SSH token's app caveat names */
  numericId: number;
  /** slug of the organization owning the app, when reported */
  organization: string | undefined;
}

/** one service a machine declares, as far as exposure depends on it */
export interface FlyServiceRoute {
  /** port the guest listens on */
  internalPort: number;
  /** whether the proxy starts or resumes the machine on a request */
  autostart: boolean;
  /** whether, and how, the proxy stops an idle machine */
  autostop: string;
}

/** the CPUs and memory a machine runs on, as the Machines API reports them */
export interface FlyGuest {
  /** the preset family: shared CPUs or dedicated performance CPUs */
  cpuKind: 'shared' | 'performance';
  /** number of CPUs */
  cpus: number;
  /** memory in megabytes */
  memoryMb: number;
}

/** a Fly Machine, validated from the Machines API */
export interface FlyMachine {
  /** immutable machine identity */
  id: string;
  /** identity of the current run of the machine, which each restart replaces */
  instanceId?: string;
  /** CPUs and memory the machine runs on, when the API reports them */
  guest?: FlyGuest;
  /** current run state, such as started, stopped or suspended */
  state: string;
  /** creation time as an ISO 8601 timestamp */
  createdAt?: string;
  /** string metadata keys the machine carries */
  metadata: Readonly<Record<string, string>>;
  /** services the machine declares */
  routes: readonly FlyServiceRoute[];
}

/** the whole configuration of a machine, as read before an update */
interface FlyMachineConfig {
  /** every configuration key except the guest, untouched */
  config: Record<string, unknown>;
  /** the guest entry, with every key it carries */
  guest: Record<string, unknown>;
  /** identity of the run the update is made from, when reported */
  instanceId?: string;
}

/** one machine of an organization-wide listing */
export interface FlyOrgMachine extends FlyMachine {
  /** app the machine belongs to */
  app: string;
}

/** a page of the organization-wide machine listing */
interface FlyMachinePage {
  /** machines on this page */
  machines: FlyOrgMachine[];
  /** cursor of the next page; absent on the last page */
  nextCursor?: string;
  /** regions that could not be listed, so the listing is incomplete */
  errorRegions: string[];
}

/** the kinds of address an app can hold, as flyctl classifies them */
type FlyIpType =
  'v4' | 'v6' | 'shared_v4' | 'private_v6' | 'egress_v4' | 'egress_v6';

/** the addresses that make a workstation reachable from the internet */
export const PUBLIC_IP_TYPES: ReadonlySet<FlyIpType> = new Set([
  'v4',
  'v6',
  'shared_v4',
]);

/** one address assigned to an app */
export interface FlyIpAssignment {
  /** the address */
  ip: string;
  /** whether the address is a shared IPv4 address */
  shared: boolean;
  /** what kind of address it is; the API reports no type of its own */
  type: FlyIpType;
}

/** a command's buffered outcome from the REST exec endpoint */
export interface FlyExecResult {
  /** exit status, when the endpoint reported one */
  exitCode?: number;
  /** captured standard output */
  stdout: string;
  /** captured standard error */
  stderr: string;
}

const HTTPS_PORT = 443;
const HTTP_PORT = 80;

/**
 * validates an app record
 * @param data untrusted response body
 * @returns validated identity, numeric identity and organization
 */
export function parseApp(data: unknown): FlyApp {
  if (
    !isRecord(data) ||
    typeof data.id !== 'string' ||
    typeof data.name !== 'string' ||
    !Number.isSafeInteger(data.internal_numeric_id)
  ) {
    throw malformed('app');
  }
  const organization = isRecord(data.organization)
    ? data.organization.slug
    : undefined;

  return {
    id: data.id,
    name: data.name,
    numericId: Number(data.internal_numeric_id),
    organization: typeof organization === 'string' ? organization : undefined,
  };
}

/**
 * validates a machine record
 * @param data untrusted response body or list entry
 * @returns validated identity, state, metadata and routes
 */
export function parseMachine(data: unknown): FlyMachine {
  if (
    !isRecord(data) ||
    typeof data.id !== 'string' ||
    typeof data.state !== 'string'
  ) {
    throw malformed('machine');
  }
  const config = isRecord(data.config) ? data.config : {};
  const guest = parseGuest(config.guest);

  return {
    id: data.id,
    ...(typeof data.instance_id === 'string'
      ? { instanceId: data.instance_id }
      : {}),
    ...(guest ? { guest } : {}),
    state: data.state,
    ...(typeof data.created_at === 'string'
      ? { createdAt: data.created_at }
      : {}),
    metadata: parseMetadata(config.metadata),
    routes: Array.isArray(config.services)
      ? config.services.flatMap(parseRoute)
      : [],
  };
}

/**
 * keeps what an update must post back of a machine: its whole configuration
 * @param data untrusted response body
 * @returns the configuration, its guest entry and the run to update from
 */
export function parseMachineConfig(data: unknown): FlyMachineConfig {
  if (!isRecord(data) || !isRecord(data.config)) {
    throw malformed('machine configuration');
  }
  const { guest, ...config } = data.config;

  return {
    config,
    guest: isRecord(guest) ? guest : {},
    ...(typeof data.instance_id === 'string'
      ? { instanceId: data.instance_id }
      : {}),
  };
}

/**
 * validates a list of machines
 * @param data untrusted response body
 * @returns every machine, each validated
 */
export function parseMachines(data: unknown): FlyMachine[] {
  if (!Array.isArray(data)) {
    throw malformed('machine list');
  }

  return data.map(parseMachine);
}

/**
 * validates one page of the organization-wide machine listing
 * @param data untrusted response body
 * @returns validated machines, next cursor and failed regions
 */
export function parseMachinePage(data: unknown): FlyMachinePage {
  if (!isRecord(data) || !Array.isArray(data.machines ?? [])) {
    throw malformed('machine listing');
  }
  const entries: unknown[] = Array.isArray(data.machines) ? data.machines : [];
  const machines = entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.app_name !== 'string') {
      throw malformed('machine listing');
    }

    return { ...parseMachine(entry), app: entry.app_name };
  });
  const cursor = data.next_cursor;

  return {
    machines,
    ...(typeof cursor === 'string' && cursor !== ''
      ? { nextCursor: cursor }
      : {}),
    errorRegions: Array.isArray(data.error_regions)
      ? data.error_regions.filter((region) => typeof region === 'string')
      : [],
  };
}

/**
 * validates a created volume
 * @param data untrusted response body
 * @returns the volume identity
 */
export function parseVolumeId(data: unknown): string {
  if (!isRecord(data) || typeof data.id !== 'string') {
    throw malformed('volume');
  }

  return data.id;
}

/**
 * validates the addresses assigned to an app
 * @param data untrusted response body
 * @returns the assignments
 */
export function parseIps(data: unknown): FlyIpAssignment[] {
  const ips = isRecord(data) ? (data.ips ?? []) : undefined;
  if (!Array.isArray(ips)) {
    throw malformed('address listing');
  }

  return ips.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.ip !== 'string') {
      throw malformed('address listing');
    }
    const shared = entry.shared === true;

    return {
      ip: entry.ip,
      shared,
      type: ipType(entry.ip, shared, entry.egress === true),
    };
  });
}

/**
 * classifies an address the way flyctl does, since the listing carries no
 * type: an egress address first, then a private Flycast address in the
 * fdaa::/16 network, then a shared IPv4 address, then by family
 * @param ip the address
 * @param shared whether it is a shared IPv4 address
 * @param egress whether it is an egress address
 * @returns the address type
 */
function ipType(ip: string, shared: boolean, egress: boolean): FlyIpType {
  const v6 = ip.includes(':');
  if (egress) {
    return v6 ? 'egress_v6' : 'egress_v4';
  }
  if (ip.toLowerCase().startsWith(PRIVATE_V6_PREFIX)) {
    return 'private_v6';
  }
  if (shared) {
    return 'shared_v4';
  }

  return v6 ? 'v6' : 'v4';
}

/**
 * validates a REST exec outcome
 * @param data untrusted response body
 * @returns exit status and output
 */
export function parseExec(data: unknown): FlyExecResult {
  if (!isRecord(data)) {
    throw malformed('exec result');
  }

  return {
    ...(Number.isSafeInteger(data.exit_code)
      ? { exitCode: Number(data.exit_code) }
      : {}),
    stdout: typeof data.stdout === 'string' ? data.stdout : '',
    stderr: typeof data.stderr === 'string' ? data.stderr : '',
  };
}

/**
 * reads the organizations an organization token reports about itself
 * @param data untrusted response body
 * @returns organization slugs
 */
export function parseTokenOrganizations(data: unknown): string[] {
  const tokens = isRecord(data) ? data.tokens : undefined;

  return Array.isArray(tokens)
    ? tokens.flatMap((token: unknown) =>
        isRecord(token) && typeof token.org_slug === 'string'
          ? [token.org_slug]
          : [],
      )
    : [];
}

/**
 * reads the region the API names nearest the caller
 * @param data untrusted response body
 * @returns region code, when reported
 */
export function parseNearestRegion(data: unknown): string | undefined {
  return isRecord(data) && typeof data.nearest === 'string'
    ? data.nearest
    : undefined;
}

/**
 * renders a machine description as the Machines API configuration: HTTPS on
 * 443, and HTTP on 80 redirected to HTTPS, route to the ACP agent port with
 * proxy auto-start on and auto-stop off
 * @param spec machine description
 * @returns the API configuration
 */
export function wireMachineConfig(spec: MachineSpec): Record<string, unknown> {
  return {
    image: spec.image,
    guest: wireGuest(spec.guest),
    init: { exec: [...spec.init] },
    files: spec.files.map((file) => ({
      guest_path: file.guestPath,
      raw_value: Buffer.from(file.contents).toString('base64'),
      mode: file.mode,
    })),
    stop_config: { timeout: `${spec.stopSeconds}s` },
    rootfs: { persist: spec.rootfs },
    mounts: [{ volume: spec.volume, path: spec.mountPath }],
    restart: { policy: 'on-failure' },
    services: [
      {
        protocol: 'tcp',
        internal_port: spec.port,
        autostart: true,
        autostop: 'off',
        ports: [
          { port: HTTPS_PORT, handlers: ['tls', 'http'] },
          { port: HTTP_PORT, handlers: ['http'], force_https: true },
        ],
      },
    ],
    metadata: { ...spec.metadata },
  };
}

/**
 * renders a guest as the Machines API configuration
 * @param guest CPUs and memory to run on
 * @returns the API guest
 */
export function wireGuest(guest: FlyGuest): Record<string, unknown> {
  return {
    cpu_kind: guest.cpuKind,
    cpus: guest.cpus,
    memory_mb: guest.memoryMb,
  };
}

/**
 * reads the CPUs and memory of a machine configuration
 * @param data untrusted guest entry
 * @returns the guest, or nothing when the entry does not describe one
 */
function parseGuest(data: unknown): FlyGuest | undefined {
  if (
    !isRecord(data) ||
    (data.cpu_kind !== 'shared' && data.cpu_kind !== 'performance') ||
    typeof data.cpus !== 'number' ||
    typeof data.memory_mb !== 'number'
  ) {
    return undefined;
  }

  return {
    cpuKind: data.cpu_kind,
    cpus: data.cpus,
    memoryMb: data.memory_mb,
  };
}

/**
 * keeps the string metadata keys of a machine configuration
 * @param data untrusted metadata
 * @returns string keys only
 */
function parseMetadata(data: unknown): Record<string, string> {
  return isRecord(data)
    ? Object.fromEntries(
        Object.entries(data).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};
}

/**
 * reads the routing fields of one declared service
 * @param data untrusted service entry
 * @returns the route, or nothing for an entry without an internal port
 */
function parseRoute(data: unknown): FlyServiceRoute[] {
  if (!isRecord(data) || !Number.isSafeInteger(data.internal_port)) {
    return [];
  }

  return [
    {
      internalPort: Number(data.internal_port),
      autostart: data.autostart === true,
      // the API reports a disabled auto-stop as either false or off
      autostop:
        data.autostop === false
          ? 'off'
          : typeof data.autostop === 'string'
            ? data.autostop
            : '',
    },
  ];
}

/**
 * describes a successful response that does not have the documented shape
 * @param what resource the response should describe
 * @returns the failure
 */
function malformed(what: string): ProviderFault {
  return new ProviderFault({
    code: 'failed',
    message: `The Fly Machines API returned a malformed ${what}`,
  });
}
