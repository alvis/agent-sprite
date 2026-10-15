// environment.json: the one record setup leaves on the guest. The guest's sh
// programs (updater, links, service backend, launchers, governor, boot hook)
// read it with jq, and the host reads it back to inspect, update and destroy

import { CommandFault } from '#errors';
import { GUEST_ROOT } from '#guest/guest-root';
import { isRecord } from '#utilities/guards';

import { environmentProblem } from './environment-validation.js';

import type { WorkstationProfile } from '#core/profile';
import type { IdleForm, KeepAwakeMode, WakeMode } from '#drivers/contracts';
import type {
  GuestAccount,
  GuestCommand,
  ServiceDefinition,
} from '#drivers/guest-channel';
import type { NetworkLauncher } from '#drivers/networks/contracts';
import type { PeriodicJob, ServiceBackendId } from '#os/contracts';
import type { ToolOwner, ToolSource } from '#tools/contracts';

import type { GuestNetworkIdentity } from './types.js';

/** where setup records the guest's environment */
export const ENVIRONMENT_PATH = `${GUEST_ROOT}/environment.json`;

/** the record's mode: root writes it, every account reads it */
export const ENVIRONMENT_MODE = 0o644;

/** the record's format version */
export const ENVIRONMENT_SCHEMA = 1;

/** how the last setup ended: `incomplete` when a critical step failed */
export type EnvironmentSetupState = 'ready' | 'incomplete';

/** one installed tool and the source setup resolved for it */
export interface EnvironmentTool {
  /** tool name */
  name: string;
  /** whether setup refuses without it */
  required: boolean;
  /** account that owns the tool's files, which its source decides */
  account: ToolOwner;
  /** executables a `brew` tool links into `/usr/local/bin` */
  executables: readonly string[];
  /** the resolved source; the updater upgrades and the boot hook relinks by its `kind` */
  source: ToolSource;
}

/** an optional tool setup skipped since no source of it is usable */
export interface SkippedTool {
  /** tool name */
  name: string;
  /** why no source is usable */
  reason: string;
}

/** the provider's facts the idle governor and its awake adapter read */
export interface EnvironmentProvider {
  /** provider identifier */
  id: string;
  /** who runs the guest services */
  serviceBackend: ServiceBackendId;
  /** who decides when the workstation sleeps */
  keepAwakeMode: KeepAwakeMode;
  /** idle forms in preference order */
  idleForms: readonly IdleForm[];
  /** how a sleeping workstation is woken */
  wakeMode: WakeMode;
  /** a cli-restore provider opts in to governor-initiated sleep */
  supportsCliWakeSleep: boolean;
  /** furthest ahead, in minutes, one deadline keeps the workstation awake; null when unlimited */
  maxAwakeDeadlineMinutes: number | null;
  /** CIDR prefixes of the provider's transport, which a network tunnel must never route */
  transportNetworks: readonly string[];
  /** minutes without heartbeat or hold before sleep, capped at the deadline limit; 0 never sleeps */
  idleTimeoutMinutes: number;
  /** minutes a turn hold lasts after its last refresh, capped at the deadline limit */
  holdMaxMinutes: number;
}

/** a command recorded for a guest program to run */
export type EnvironmentCommand = Pick<
  GuestCommand,
  'program' | 'arguments' | 'account' | 'environment'
>;

/** one selected harness, as the agent's launcher passes it on */
export interface EnvironmentHarness {
  /** harness identifier */
  id: string;
  /** environment the agent passes when spawning the harness */
  environment: Readonly<Record<string, string>>;
  /** the ACP adapter the harness provides, when it provides one */
  adapter?: {
    /** the adapter's tool name in `tools` */
    tool: string;
    /** command the agent runs to launch the adapter */
    launch: EnvironmentCommand;
  };
}

/** the selected ACP agent, as its launcher starts it */
export interface EnvironmentAgent {
  /** agent identifier */
  id: string;
  /** name of the agent's service in `services` */
  service: string;
  /** account the agent runs as */
  account: GuestAccount;
  /** port the agent listens on and the provider routes to */
  port: number;
  /** the selected harnesses, in selection order */
  harnesses: readonly EnvironmentHarness[];
}

/** the selected private network, as its launcher runs it */
export interface EnvironmentNetwork {
  /** network identifier */
  id: string;
  /** name of the network's daemon in `services` */
  daemon: string;
  /** where the daemon keeps its state, socket and tunnel, as its launcher reads them */
  launcher: Omit<NetworkLauncher, 'asset'>;
}

/** the record setup leaves at {@link ENVIRONMENT_PATH} */
export interface GuestEnvironment {
  /** format version */
  schema: typeof ENVIRONMENT_SCHEMA;
  /** the open-agent release that last set the guest up */
  openAgent: {
    /** its version; destroy refuses a guest a newer release set up */
    version: string;
    /** when it finished, as an ISO 8601 timestamp */
    setupAt: string;
  };
  /** how the last setup ended, and the optional tools it skipped */
  setup: {
    /** `incomplete` when a critical step failed */
    state: EnvironmentSetupState;
    /** optional tools with no usable source */
    skipped: readonly SkippedTool[];
  };
  /** the workstation's profile */
  profile: WorkstationProfile;
  /** the installed tools */
  tools: readonly EnvironmentTool[];
  /** the updater's schedule */
  schedule: {
    /** days after the last successful update before the next is due */
    dueDays: number;
  };
  /** the provider's facts */
  provider: EnvironmentProvider;
  /** the agent's launch facts */
  agent: EnvironmentAgent;
  /** the selected network's launch facts; null when it runs no daemon */
  network: EnvironmentNetwork | null;
  /** the services the service backend runs, the agent's and the network daemon's included */
  services: readonly ServiceDefinition[];
  /** the commands the service backend runs on a schedule */
  jobs: readonly PeriodicJob[];
  /** the retained network device identity, for cleanup; absent until a device enrolls */
  networkIdentity?: GuestNetworkIdentity;
}

/**
 * renders the record as the file setup writes
 * @param environment the record
 * @returns its JSON text, ending in a newline
 */
export function serializeEnvironment(environment: GuestEnvironment): string {
  return `${JSON.stringify(environment, null, 2)}\n`;
}

/**
 * reads the record back and validates it field by field
 * @param text the file's contents
 * @returns the record
 * @throws {CommandFault} when the record has a format version this release does not know
 * @throws {Error} when the record is not JSON or is malformed
 */
export function parseEnvironment(text: string): GuestEnvironment {
  const value: unknown = JSON.parse(text);
  if (
    isRecord(value) &&
    value.schema !== undefined &&
    value.schema !== ENVIRONMENT_SCHEMA
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Guest environment format version ${JSON.stringify(value.schema)} is not supported by this open-agent release; it was left unchanged`,
    });
  }
  if (!isRecord(value) || value.schema !== ENVIRONMENT_SCHEMA) {
    throw new Error('The guest environment is malformed: it has no schema');
  }
  const problem = environmentProblem(value);
  if (problem) {
    throw new Error(`The guest environment is malformed: ${problem}`);
  }

  return value as unknown as GuestEnvironment;
}
