import type { GitIdentity } from '#domain/git';
import type { AgentId, NetworkId } from '#domain/ids';
import type { AgentEnvironments } from '#domain/observations/agent';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { GuestInspection } from '#domain/observations/inspection';
import type { UpdateStatus } from '#domain/observations/updates';
import type { WorkstationProfile } from '#domain/profile';
import type { ServiceDefinition } from '#domain/services';
import type { RefusedSource } from '#domain/tools';
import type { WorkstationRecord } from '#domain/workstation';
import type { CommandFault } from '#kernel/faults';
import type { Secret } from '#kernel/secret';

import type {
  NetworkIdentityRecorder,
  ProviderDriver,
  ProxyRoute,
} from './drivers';
import type { GuestChannel, GuestServiceControl } from './guest-channel';
import type {
  AssemblyParams,
  PlanReport,
  PlanRunParams,
  SetupAssembly,
} from './plan';
import type { SetupConnectionParams, SetupSession } from './session';

/** the fixed places and commands the guest programs are reached at */
export interface GuestFacts {
  /** the idle governor's command, run by hooks and holds */
  awakeCommand: string;
  /** the update gate's installed command, run as root to force an update */
  updateGateCommand: string;
  /** the updater's log on the guest */
  updateLog: string;
  /** where setup records environment.json */
  environmentPath: string;
}

/** one thing an inspection reads, named without its commands */
export type InspectionProbe =
  | 'inspection'
  | 'services'
  | 'network'
  | 'native'
  | 'proxy'
  | 'governor'
  | 'boot';

/** the lifecycle of one probe an inspection runs */
export type ProbeEvent =
  | { probe: InspectionProbe; phase: 'started' }
  | {
      probe: InspectionProbe;
      phase: 'completed' | 'failed';
      /** how long the probe ran, in milliseconds */
      durationMs: number;
    };

/** what an inspection observes and reads besides the guest itself */
export interface InspectionParams {
  /** the provider, whose boot record is read when it keeps one */
  provider?: Pick<ProviderDriver, 'inspectBoot'>;
  /** observer for actual probe starts and elapsed completions */
  onProbe?: (event: ProbeEvent) => void;
}

/**
 * where a command learns which release set a workstation up: `metadata` never
 * wakes the guest, `guest` reads environment.json and fails when it cannot,
 * and `guest-or-metadata` falls back to the metadata when the guest is unreadable
 */
export type ReleaseSource = 'metadata' | 'guest' | 'guest-or-metadata';

/** where GitHub CLI is authenticated */
export interface GithubTarget {
  /** selected GitHub host; github.com when absent */
  hostname?: string;
  /** provider shell accounts that share the agent account's login */
  shellAccounts: readonly string[];
}

/** what the provider's own services are installed from */
export interface ProviderServiceParams {
  /** the provider's own service control */
  control: GuestServiceControl;
  /** the services the plan records */
  services: readonly ServiceDefinition[];
  /** names of the services an earlier setup recorded */
  previous: readonly string[];
}

/** how the guest's recorded environment is read and written */
export interface GuestEnvironmentAccess {
  /**
   * reads the environment setup recorded on the guest
   * @param guest target guest
   * @returns the record
   * @throws {CommandFault} when its format version is unknown
   * @throws {Error} when it is missing or malformed
   */
  read(guest: GuestChannel): Promise<GuestEnvironment>;
  /**
   * reads the environment setup recorded, when it recorded one
   * @param guest target guest
   * @returns the record, or nothing before setup first wrote it
   */
  find(guest: GuestChannel): Promise<GuestEnvironment | undefined>;
  /**
   * replaces the recorded environment atomically, readable by every account
   * @param guest target guest
   * @param environment the record
   * @throws {CommandFault} when the record's profile is invalid
   */
  write(guest: GuestChannel, environment: GuestEnvironment): Promise<void>;
  /**
   * records a profile whose change no tool, service or job follows
   * @param guest target guest
   * @param profile the profile to record
   */
  writeProfile(guest: GuestChannel, profile: WorkstationProfile): Promise<void>;
  /**
   * keeps a network device identity in the recorded environment, owned by the
   * network that enrolled it
   * @param guest target guest
   * @param network the network whose device the identity names
   * @returns the recorder a network driver calls with each identity it observes
   */
  identityRecorder(
    guest: GuestChannel,
    network: NetworkId,
  ): NetworkIdentityRecorder;
  /**
   * refuses to go on when the recorded integration choices changed while
   * inputs were being collected
   * @param guest target guest
   * @param expected the profile the inputs were collected for
   * @throws {CommandFault} when the network, exit node or gateway choice differs
   */
  assertProfile(
    guest: GuestChannel,
    expected: WorkstationProfile,
  ): Promise<void>;
  /**
   * reads what the updater recorded about its last run
   * @param guest target guest
   * @returns the record, or nothing when no update ran or it cannot be read
   */
  readUpdateStatus(guest: GuestChannel): Promise<UpdateStatus | undefined>;
}

/** the mechanics of a guest's native tooling configuration */
export interface GuestNativeConfiguration {
  /**
   * asks the selected agent's own environment check
   * @param guest target guest
   * @param agent selected ACP agent, else the default
   * @returns what the running agent service reports, absent when it could not be probed
   */
  inspectAgentEnvironment(
    guest: GuestChannel,
    agent?: AgentId,
  ): Promise<AgentEnvironments[AgentId] | undefined>;
  /**
   * sets the selected Git and Jujutsu identity for the non-root runtime account
   * @param guest target guest
   * @param identity selected author and committer identity
   */
  configureGit(guest: GuestChannel, identity: GitIdentity): Promise<void>;
  /**
   * authenticates GitHub CLI using a selected credential over stdin
   * @param guest target guest, running over a setup session
   * @param token GitHub credential, piped to the native CLI as session input
   * @param target selected GitHub host and provider shell accounts
   */
  configureGithub(
    guest: GuestChannel,
    token: Secret,
    target: GithubTarget,
  ): Promise<void>;
  /**
   * stores only explicitly requested application runtime variables, for the
   * agent service and every shell of the agent and the provider shell accounts
   * @param guest target guest
   * @param environment approved runtime variables
   * @param shellAccounts provider shell accounts whose shells also read them
   */
  configureRuntimeEnv(
    guest: GuestChannel,
    environment: Record<string, string>,
    shellAccounts: readonly string[],
  ): Promise<void>;
  /**
   * copies a setup file to the guest's /tmp, runs it once as root and removes it
   * @param guest target guest, running over a setup session
   * @param contents the setup file's exact bytes
   */
  runSetupFile(guest: GuestChannel, contents: Buffer): Promise<void>;
  /**
   * refuses runtime variables that would override a credential, the
   * environment open-agent sets or the OA_* names its guest programs reserve
   * @param environment requested runtime variables
   * @throws {CommandFault} when a variable is restricted or reserved
   */
  assertRuntimeEnv(environment: Record<string, string>): void;
}

/**
 * everything the application asks of a guest's mechanics: the setup session,
 * the plan and its steps, the recorded environment, the inspection probes
 * and the native configuration. The adapters implement it; the application
 * decides when each runs
 */
export interface GuestMechanics {
  /** the fixed places and commands of the guest */
  facts: GuestFacts;
  session: {
    /**
     * binds a setup session to a workstation without opening it
     * @param params the provider and the workstation
     * @returns the session
     */
    connect(params: SetupConnectionParams): SetupSession;
  };
  plan: {
    /**
     * assembles the setup plan for a probed release
     * @param params the provider, profile, release and version
     * @returns the steps, the resolved tools and the environment they record
     * @throws {CommandFault} when a required tool has no usable source on the guest
     */
    assemble(params: AssemblyParams): Promise<SetupAssembly>;
    /**
     * tells whether the plan installs Homebrew formulae whose bottles the
     * installed Homebrew should be asked about
     * @param assembly the assembled plan
     * @returns true when the foundation installs Homebrew and a tool resolved to a formula
     */
    needsBottleProbe(assembly: SetupAssembly): boolean;
    /**
     * asks the installed Homebrew which formulae have no bottle
     * @param session the setup session, whose foundation has run
     * @param assembly the assembled plan
     * @returns the sources the guest turns down
     * @throws {CommandFault} when Homebrew cannot report
     */
    probeBottles(
      session: SetupSession,
      assembly: SetupAssembly,
    ): Promise<readonly RefusedSource[]>;
    /**
     * runs steps in the order their needs allow, reporting facts only
     * @param params the steps, the session opener and the progress callback
     * @returns every step's outcome
     */
    run(params: PlanRunParams): Promise<PlanReport>;
    /**
     * refuses, before the provider creates anything, a selection whose
     * required tools no source serves on the provider's default image
     * @param provider the provider, whose default image is checked
     * @param profile the selection
     * @throws {CommandFault} when a required tool has no usable source on the image
     */
    assertImageTools(
      provider: Pick<ProviderDriver, 'images' | 'serviceBackend'>,
      profile: WorkstationProfile,
    ): void;
  };
  services: {
    /**
     * registers the services a provider runs itself
     * @param params the provider's control, the services and the earlier names
     */
    installProvider(params: ProviderServiceParams): Promise<void>;
  };
  environment: GuestEnvironmentAccess;
  inspection: {
    /**
     * reads current service, route and installation state
     * @param guest target guest
     * @param params the provider whose boot record is read, and the probe observer
     * @returns current service, network, native, gateway, environment, update and boot status
     */
    inspect(
      guest: GuestChannel,
      params?: InspectionParams,
    ): Promise<GuestInspection>;
  };
  native: GuestNativeConfiguration;
  label: {
    /**
     * names the guest after its workstation
     * @param guest target guest
     * @param label name of the workstation the guest belongs to
     */
    write(guest: GuestChannel, label: string): Promise<void>;
  };
  release: {
    /**
     * refuses a workstation a newer open-agent release set up
     * @param provider the provider the workstation runs on
     * @param workstation record of the machine checked
     * @param source where the recorded release is read from
     * @throws {CommandFault} when the recorded release is newer than this one
     */
    assertSupported(
      provider: Pick<ProviderDriver, 'openGuest'>,
      workstation: WorkstationRecord,
      source: ReleaseSource,
    ): Promise<void>;
    /**
     * names the release a workstation's metadata records when it is newer
     * than this one, without waking the guest
     * @param workstation record of the machine checked
     * @returns the newer recorded release, or nothing
     */
    newerMetadata(workstation: WorkstationRecord): string | undefined;
  };
  hub: {
    /**
     * records the gateway the probe checks, or forgets it when routing is off
     * @param guest target guest
     * @param route CLIProxyAPI route, or undefined when no gateway is configured
     */
    record(guest: GuestChannel, route: ProxyRoute | undefined): Promise<void>;
  };
}
