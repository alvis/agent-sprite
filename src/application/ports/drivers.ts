import type {
  GuestChannel,
  GuestProcess,
} from '#application/ports/guest-channel';
import type { SetupStep } from '#application/ports/plan';
import type {
  AgentDeclaration,
  AgentPairing,
  ExposureVisibility,
  GatewayDeclaration,
  HarnessDeclaration,
  MachineOffer,
  NetworkDeclaration,
  NetworkLauncher,
  ProviderDeclaration,
} from '#domain/declarations';
import type { GuestAsset } from '#domain/guest';
import type {
  AgentId,
  GatewayId,
  HarnessId,
  NetworkId,
  ProviderId,
} from '#domain/ids';
import type { AgentEnvironments } from '#domain/observations/agent';
import type { BootReport } from '#domain/observations/boot';
import type {
  HarnessInspection,
  HarnessPluginEvidence,
  NativeHarnessInspection,
} from '#domain/observations/harness';
import type {
  NetworkIdentity,
  NetworkStatus,
  NetworkStatuses,
} from '#domain/observations/network';
import type {
  PrerequisiteProblem,
  ProviderPreflightParams,
} from '#domain/prerequisites';
import type { WorkstationProfile } from '#domain/profile';
import type { ReadinessFinding } from '#domain/readiness';
import type { GuestServiceState } from '#domain/services';
import type { ToolSpec } from '#domain/tools';
import type {
  WorkstationMetadata,
  WorkstationRecord,
} from '#domain/workstation';
import type { Secret } from '#kernel/secret';

/** what core binds a provider to before any provider call */
export interface ProviderBinding {
  /** provider management credential kept on this computer */
  credential: string;
  /**
   * names of the managed services the provider may stop and restore while
   * replacing a service they depend on; every other dependent blocks the replacement
   */
  restorableServices: readonly string[];
}

/** a provider: where the workstation runs and how it is reached */
export interface ProviderDriver<
  Name extends string = string,
> extends ProviderDeclaration<Name> {
  /**
   * checks every declared prerequisite without a provider call, so a command
   * reports all missing or misconfigured items at once
   * @param params resolved credential and a host tool lookup
   * @returns every problem found, each with its fix; empty when ready
   */
  preflight(params: ProviderPreflightParams): Promise<PrerequisiteProblem[]>;
  /**
   * binds the provider management credential and the facts core supplies;
   * operations on an unbound driver reject with an authentication failure
   * @param binding management credential and the services core may restore
   * @returns the same provider bound to the credential
   */
  authenticate(binding: ProviderBinding): ProviderDriver<Name>;
  /**
   * lists managed workstations from live provider records
   * @returns managed workstations
   */
  list(): Promise<WorkstationRecord[]>;
  /**
   * fetches one managed workstation, rejecting with not-found when none exists
   * so the provider's own diagnostic reaches the user
   * @param name exact workstation name
   * @returns the managed workstation
   */
  get(name: string): Promise<WorkstationRecord>;
  /**
   * tells whether any provider resource, managed or not, already uses a name
   * @param name proposed workstation name
   * @returns true when creating the name would collide
   */
  isNameTaken(name: string): Promise<boolean>;
  /**
   * provisions privately and records ownership and the profile summary
   * @param name workstation name
   * @param profile validated profile
   * @param port ACP agent port a later `expose` publishes; a provider that
   * must declare the route when it provisions does so here, unreachable
   * until exposure
   * @returns the created workstation
   */
  create(
    name: string,
    profile: WorkstationProfile,
    port: number,
  ): Promise<WorkstationRecord>;
  /**
   * deletes after rechecking immutable identity
   * @param workstation previously observed workstation
   */
  delete(workstation: WorkstationRecord): Promise<void>;
  /**
   * writes ownership, schema, setup state and profile summary; never credentials
   * @param workstation managed workstation
   * @param metadata setup state and profile summary to record
   * @returns the workstation as recorded after the update
   */
  setMetadata(
    workstation: WorkstationRecord,
    metadata: WorkstationMetadata,
  ): Promise<WorkstationRecord>;
  /**
   * moves the workstation to a machine size, doing nothing when it already
   * runs on it; every other setting of the workstation is preserved
   * @param workstation managed workstation
   * @param offer machine size to run on
   * @returns the workstation as recorded after the change
   */
  resize(
    workstation: WorkstationRecord,
    offer: MachineOffer,
  ): Promise<WorkstationRecord>;
  /**
   * publishes the ACP agent port, only after readiness
   * @param workstation managed workstation
   * @param port ACP agent port
   * @param visibility who may reach the port
   */
  expose(
    workstation: WorkstationRecord,
    port: number,
    visibility: ExposureVisibility,
  ): Promise<void>;
  /**
   * opens the provider-neutral guest channel
   * @param workstation managed workstation
   * @returns the guest channel
   */
  openGuest(workstation: WorkstationRecord): Promise<GuestChannel>;
  /**
   * opens a root shell that reads its commands from standard input, for a
   * setup session; how it becomes root is the provider's own
   * @param workstation managed workstation
   * @param shell absolute path of the OS family's shell, such as `/bin/dash`
   * @returns the running shell
   */
  openRootShell(
    workstation: WorkstationRecord,
    shell: string,
  ): Promise<GuestProcess>;
  /**
   * waits until the guest has finished booting, so setup never races the
   * provider's own boot work
   * @param workstation managed workstation
   */
  awaitGuestReady(workstation: WorkstationRecord): Promise<void>;
  /**
   * builds the step that installs the provider's boot hook and prepares the
   * guest with it, which setup runs before any package step; absent when the
   * provider declares no boot hook
   * @param needs ids of the steps installing the libraries the hook sources
   * @returns the boot hook step
   */
  bootHookStep?(needs: readonly string[]): Promise<SetupStep>;
  /**
   * reads what the boot hook recorded about the last boot, for doctor;
   * absent when the provider declares no boot hook
   * @param guest guest channel of the workstation
   * @returns the last boot's result, its steps and its log's latest lines
   */
  inspectBoot?(guest: GuestChannel): Promise<BootReport>;
}

/** documented native client endpoints derived from one gateway hub URL */
export interface GatewayEndpoints {
  /** hub root, without a version prefix */
  root: string;
  /** hub root with the versioned API prefix */
  versioned: string;
  /** non-billable model catalogue endpoint */
  models: string;
}

/** the gateway credentials a run resolved, absent when no source holds them */
export interface GatewayPreflightParams {
  /** hub URL */
  url?: string;
  /** hub client key */
  apiKey?: string;
}

/** a model gateway harnesses can route through, with the rules for its hub URL and credentials */
export interface GatewayDriver<
  Name extends string = string,
> extends GatewayDeclaration<Name> {
  /**
   * derives the hub root and the versioned API base without duplicate prefixes; a malformed URL, or one carrying credentials, a query or a fragment, is refused
   * @param baseUrl hub URL, optionally ending in /v1
   * @returns client bases and the non-billable model catalogue endpoint
   */
  endpoints(baseUrl: string): GatewayEndpoints;
  /**
   * reports invalid direct gateway inputs without exposing their contents
   * @param baseUrl optional supplied hub URL
   * @returns aggregate-preflight diagnostics for a malformed hub URL
   */
  urlProblems(baseUrl?: string): string[];
  /**
   * checks, offline, that every credential a harness routed through the
   * gateway needs is present
   * @param params the resolved hub URL and client key
   * @returns one problem per absent credential, each with its fix
   */
  preflight(params: GatewayPreflightParams): PrerequisiteProblem[];
}

/** CLIProxyAPI routing applied to a proxy-capable harness */
export interface ProxyRoute {
  /** the endpoints derived from the hub base URL */
  endpoints: GatewayEndpoints;
  /** hub client API key, persisted only in protected native configuration */
  apiKey: string;
}

/** inputs for one native configuration merge */
export interface HarnessConfigureParams {
  /** CLIProxyAPI route, or undefined to restore native authentication */
  proxy?: ProxyRoute;
}

/** command the idle-governor hooks call on the guest */
export interface AwakeHookCommand {
  /**
   * command-line prefix of the awake command; the harness appends the awake
   * action, its own identifier as the source and `--session -`
   */
  program: string;
}

/** native plugin changes for one harness; empty arrays preserve existing state */
export interface PluginActions {
  /** marketplace sources to add */
  marketplaces: string[];
  /** plugin identities to install and enable */
  plugins: string[];
  /** marketplace sources or names to remove */
  removeMarketplaces: string[];
  /** plugin identities to disable */
  disablePlugins: string[];
  /** plugin identities to uninstall */
  uninstallPlugins: string[];
}

/** native marketplace plugin actions for one harness */
export interface HarnessPluginControl {
  /** repository paths where the harness documents its marketplace manifests */
  marketplaceManifests: readonly string[];
  /**
   * applies selected marketplace and plugin changes
   * @param guest guest channel
   * @param actions changes to apply; empty lists preserve existing state
   */
  apply(guest: GuestChannel, actions: PluginActions): Promise<void>;
}

/** installs idle-governor heartbeats and turn holds into native hooks */
export interface HarnessHookInstaller {
  /**
   * merges owned hooks while preserving unrelated native hooks
   * @param guest guest channel
   * @param command awake command the hooks invoke
   */
  install(guest: GuestChannel, command: AwakeHookCommand): Promise<void>;
}

/** facts the readiness checks of one harness depend on */
export interface HarnessReadinessContext {
  /** the workstation routes proxy-capable harnesses through CLIProxyAPI */
  proxy: boolean;
}

/** a coding CLI the user works through */
export interface HarnessDriver<
  Name extends string = string,
  Evidence extends HarnessPluginEvidence | undefined =
    HarnessPluginEvidence | undefined,
> extends HarnessDeclaration<Name> {
  /** the tools the harness installs, its own CLI first */
  tools: readonly ToolSpec[];
  /** native marketplace plugin actions */
  plugins: HarnessPluginControl;
  /** idle-governor hook installer */
  hooks: HarnessHookInstaller;
  /**
   * merges native configuration, preserving unrelated user settings
   * @param guest guest channel
   * @param params proxy routing to apply or restore
   */
  configure(guest: GuestChannel, params: HarnessConfigureParams): Promise<void>;
  /**
   * observes the harness's current native state
   * @param guest guest channel
   * @returns configuration, plugin and probe evidence
   */
  inspect(guest: GuestChannel): Promise<HarnessInspection<Evidence>>;
  /**
   * derives readiness findings from already gathered native evidence
   * @param inspection configuration evidence, absent when inspection failed
   * @param context facts the checks depend on
   * @returns readiness findings in reporting order
   */
  readiness(
    inspection: NativeHarnessInspection | undefined,
    context: HarnessReadinessContext,
  ): ReadinessFinding[];
}

/** facts the agent's readiness checks compare */
export interface AgentReadinessEvidence<Environment = unknown> {
  /** services currently registered on the guest */
  services: readonly GuestServiceState[];
  /** what the running agent service reports about itself, absent when it could not be observed */
  environment: Environment | undefined;
}

/**
 * agent readiness findings, grouped so core can interleave them with the
 * network and gateway findings without changing the reporting order
 */
export interface AgentReadiness {
  /** the agent service itself */
  service: ReadinessFinding[];
  /** the running agent service answering about its environment */
  environment: ReadinessFinding[];
}

/** the single service behind the workstation's public URL */
export interface AgentDriver<
  Name extends string = string,
  HarnessName extends string = string,
  Environment = unknown,
> extends AgentDeclaration<Name, HarnessName> {
  /** the tools the agent installs: its own CLI, then the runtime it needs */
  tools: readonly ToolSpec[];
  /** the launcher the service runs, which reads its launch facts from environment.json */
  launcher: GuestAsset;
  /**
   * observes what the running agent service reports about itself
   * @param guest guest channel
   * @returns the environment the service reports, absent when it could not be probed
   */
  inspectEnvironment(guest: GuestChannel): Promise<Environment | undefined>;
  /**
   * issues a pairing code; present only when supportsPairing is true
   * @param guest guest channel
   * @returns pairing credential
   */
  pair?(guest: GuestChannel): Promise<AgentPairing>;
  /**
   * proves the installed agent supports the startup options core relies on
   * @param guest guest channel
   */
  verifyStartup(guest: GuestChannel): Promise<void>;
  /**
   * derives readiness findings from already gathered evidence
   * @param evidence services and the environment the running service reports
   * @returns grouped readiness findings in reporting order
   */
  readiness(evidence: AgentReadinessEvidence<Environment>): AgentReadiness;
}

/** management credential for the network provider, kept on the caller's computer */
export interface NetworkManagement {
  /** management API key */
  credential: string;
  /** account or network the key manages; checks that read its inventory need it */
  account?: string;
}

/** an exit node the network provider verified as usable */
export interface NetworkExitNode {
  /** device identity at the network provider */
  id: string;
  /** human-readable device name */
  name: string;
  /** IPv4 address the device is reached at */
  ip: string;
}

/** inputs for checking a network before provisioning */
export interface NetworkPreflightParams {
  /** device name the workstation will register under */
  hostname: string;
  /** management credential, when the caller supplied one */
  management?: NetworkManagement;
  /** exit node selector, present only when egress is to be routed through one */
  exitNode?: string;
}

/** what a network preflight established */
export interface NetworkPreflightResult {
  /** the exit node the selector resolved to */
  exitNode?: NetworkExitNode;
  /** reasons that block provisioning, in the order the checks were made */
  problems: unknown[];
}

/** persists the retained identity of the enrolled device for later cleanup */
export type NetworkIdentityRecorder = (
  identity: NetworkIdentity,
) => Promise<void>;

/** inputs for network enrollment */
export interface NetworkEnrollParams {
  /** device name the workstation registers under */
  hostname: string;
  /** single-use enrolment credential when the guest is not registered, delivered as setup session input */
  credential?: Secret;
  /** selected exit node or native selector; absent for direct routing */
  exitNode?: NetworkExitNode | string;
  /** persists the observed device identity once enrolment is confirmed */
  recordIdentity: NetworkIdentityRecorder;
}

/** what environment.json recorded about a network before termination */
export interface NetworkRecord {
  /** identity retained from an earlier inspection of this network's device */
  identity?: NetworkIdentity;
}

/** inputs for checking a termination target before deletion */
export interface NetworkTargetParams<Status extends NetworkStatus> {
  /** identity captured from the guest */
  identity: Status;
  /** management credential, when the caller supplied one */
  management?: NetworkManagement;
  /** exit node selector the caller routes through */
  exitNode?: string;
}

/** outcome of removing a terminated workstation's network device */
export interface NetworkCleanup {
  /** whether nothing remains to be done */
  ok: boolean;
  /** what happened to the device */
  status:
    | 'no device identity recorded'
    | 'cleanup required'
    | 'deleted'
    | 'cleanup failed';
  /** why cleanup failed or was interrupted */
  cause?: Error;
}

/** inputs for removing a terminated workstation's network device */
export interface NetworkCleanupParams {
  /** identity captured before the workstation was deleted */
  identity: NetworkIdentity;
  /** management credential, when the caller supplied one */
  management?: NetworkManagement;
}

/** inputs for removing a workstation's earlier device before it enrols again */
export interface NetworkStaleDeviceParams {
  /** identity environment.json recorded for this workstation's earlier device */
  recorded: NetworkIdentity;
  /** management credential, when the caller supplied one */
  management?: NetworkManagement;
}

/** facts the network's readiness checks depend on */
export interface NetworkReadinessContext {
  /** the workstation routes egress through an exit node */
  isExitNodeEnabled: boolean;
}

/** inputs for stopping the network daemon */
export interface NetworkReleaseParams {
  /** daemon service as currently registered, absent when none is */
  service: GuestServiceState | undefined;
  /** persists the observed device identity before the daemon stops */
  recordIdentity: NetworkIdentityRecorder;
}

/**
 * an optional private-network tool; a network that is no tool, such as one
 * that selects no private network, declares no tools, `inputs` or `daemon`
 */
export interface NetworkDriver<
  Name extends string = string,
  Status extends NetworkStatus = NetworkStatus,
> extends NetworkDeclaration<Name> {
  /** the tools the network installs, installed and updated only while it is selected; empty when it installs nothing */
  tools: readonly ToolSpec[];
  /** the launcher the daemon service runs; present exactly when `daemon` is */
  launcher?: NetworkLauncher;
  /**
   * validates caller inputs and the device name before provisioning, running
   * every check even when one fails
   * @param params device name, credential and exit node selector
   * @returns the verified exit node and every blocking problem
   */
  preflight(params: NetworkPreflightParams): Promise<NetworkPreflightResult>;
  /**
   * verifies an exit node selector against the network inventory without checking the device name
   * @param management management credential and account
   * @param selector exit node name, identity or address
   * @returns the verified exit node
   */
  verifyExitNode(
    management: NetworkManagement,
    selector: string,
  ): Promise<NetworkExitNode>;
  /**
   * creates the single-use enrolment credential from the management credential
   * @param management management credential
   * @returns enrolment credential
   */
  issueCredential(management: NetworkManagement): Promise<string>;
  /**
   * starts the daemon, enrols the device or updates its exit route, and requires live evidence
   * @param guest guest channel
   * @param params enrollment inputs
   */
  enroll(guest: GuestChannel, params: NetworkEnrollParams): Promise<void>;
  /**
   * stops the daemon while retaining enrolment and cleanup identity
   * @param guest guest channel
   * @param params the daemon as currently registered
   */
  release(guest: GuestChannel, params: NetworkReleaseParams): Promise<void>;
  /**
   * inspects current network status without cached data
   * @param guest guest channel
   * @returns current status
   */
  status(guest: GuestChannel): Promise<Status>;
  /**
   * tells whether the status confirms the selected exit node
   * @param selection exit node IP, name or identity the caller selected
   * @param status current status
   * @returns whether the selected and observed exit nodes agree
   */
  matchesExitNode(selection: string, status: Status): boolean;
  /**
   * derives network readiness findings from already gathered status
   * @param status current status
   * @param context selection facts
   * @returns findings in reporting order, skipped for routing not selected
   */
  readiness(
    status: Status,
    context: NetworkReadinessContext,
  ): ReadinessFinding[];
  /**
   * captures the device identity before a workstation is deleted
   * @param guest ownership-checked guest channel
   * @param record what environment.json recorded
   * @returns captured native or persisted identity
   */
  identify(guest: GuestChannel, record: NetworkRecord): Promise<Status>;
  /**
   * refuses to delete a workstation that is, or routes through, a protected device
   * @param params captured identity and the caller's selection
   */
  assertSafeTarget(params: NetworkTargetParams<Status>): Promise<void>;
  /**
   * removes the terminated workstation's device from the network
   * @param params captured identity and management credential
   * @returns what happened to the device
   */
  cleanup(params: NetworkCleanupParams): Promise<NetworkCleanup>;
  /**
   * removes this workstation's earlier device from the network when the guest
   * has logged out, so that it enrols again under its own name instead of a
   * suffixed one; leaves a device the guest still holds untouched; absent when
   * the network keeps no named device; fails when the earlier device exists
   * and cannot be removed
   * @param guest guest channel
   * @param params identity environment.json recorded and the management credential
   */
  removeStaleDevice?(
    guest: GuestChannel,
    params: NetworkStaleDeviceParams,
  ): Promise<void>;
}

/** every registered driver, keyed by kind and identifier; the composition registry satisfies it */
export interface DriverRegistry {
  providers: { [Id in ProviderId]: ProviderDriver<Id> };
  harnesses: { [Id in HarnessId]: HarnessDriver<Id> };
  agents: {
    [Id in AgentId]: AgentDriver<Id, HarnessId, AgentEnvironments[Id]>;
  };
  networks: { [Id in NetworkId]: NetworkDriver<Id, NetworkStatuses[Id]> };
  gateways: { [Id in GatewayId]: GatewayDriver<Id> };
}
