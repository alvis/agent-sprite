import type { WorkstationProfile } from '#core/profile';
import type { GuestAsset, OsImage, ServiceBackendId } from '#os/contracts';
import type { ToolSpec } from '#tools/contracts';

import type {
  GuestAccount,
  GuestChannel,
  GuestCommand,
  GuestProcess,
  GuestServiceState,
  ServiceDefinition,
} from './guest-channel.js';
import type { HarnessPluginEvidence } from './harness-evidence.js';
import type {
  PrerequisiteProblem,
  ProviderPreflightParams,
  ProviderPrerequisites,
} from './providers/prerequisites.js';
import type { RecordedProfile } from './providers/recorded.js';

export type { RecordedProfile };

export type * from './install-sources.js';

export type * from './providers/prerequisites.js';

export type * from './networks/contracts.js';

export type * from './guest-leaves.js';

export type * from './harness-evidence.js';

/** the four dimensions a workstation selects drivers from */
export type DriverKind = 'providers' | 'harnesses' | 'agents' | 'networks';

/** how core reaches the guest */
export type GuestChannelMode = 'provider-exec' | 'ssh';

/** who decides when the workstation sleeps */
export type KeepAwakeMode = 'native-deadline' | 'governed' | 'none';

/** a state an idle workstation can enter */
export type IdleForm =
  'provider-managed' | 'memory-suspend' | 'stop' | 'disk-snapshot';

/** how a sleeping workstation is woken */
export type WakeMode = 'url-traffic' | 'cli-restore' | 'always-on';

/** where workstation data survives sleep */
export type PersistenceMode =
  'provider-disk' | 'volume' | 'snapshot' | 'host-disk';

/** how the ACP agent port is published */
export type ExposureMode = 'provider-url' | 'provider-service' | 'network-only';

/** where list finds workstations without waking them */
export type DiscoverySource = 'provider-metadata';

/** what an ACP agent launches for each selected harness */
export type HarnessLaunchMode = 'native-cli' | 'acp-adapter';

/** who can reach the ACP agent's public port */
export type ExposureVisibility = 'private' | 'public';

/** provider-recorded progress of the current provisioning attempt */
export type WorkstationSetupState = 'ready' | 'incomplete' | 'not recorded';

/** provider-neutral failure classes every provider maps its SDK errors onto */
export type ProviderErrorCode =
  | 'authentication'
  | 'not-found'
  | 'ownership-mismatch'
  | 'conflict'
  | 'transient'
  | 'failed';

/** outcome of one readiness check */
export type ReadinessStatus = 'passed' | 'failed' | 'skipped';

/** one swappable implementation of a driver kind */
export interface DriverDescriptor<
  Kind extends DriverKind = DriverKind,
  Name extends string = string,
> {
  /** catalog identifier, unique within its kind */
  id: Name;
  /** driver kind the descriptor belongs to */
  kind: Kind;
  /** human-readable name shown in menus and output */
  displayName: string;
}

/** how a provider differs from others, declared as data */
export interface ProviderCapabilities {
  /** how core reaches the guest */
  guestChannel: GuestChannelMode;
  /**
   * guest networks, as CIDR prefixes, that carry the provider's own transport
   * and so must never be routed through a network driver's tunnel; empty when
   * the provider's transport never shares a route a tunnel can capture
   */
  transportNetworks: readonly string[];
  /** who decides when the workstation sleeps */
  keepAwakeMode: KeepAwakeMode;
  /** idle forms in preference order */
  idleForms: readonly IdleForm[];
  /** how a sleeping workstation is woken */
  wakeMode: WakeMode;
  /** a cli-restore provider opts in to governor-initiated sleep */
  supportsCliWakeSleep: boolean;
  /**
   * furthest ahead, in minutes, the provider can keep a workstation awake with
   * one deadline; null when it has no limit. An idle timeout or turn-hold
   * maximum above it is refused when the profile is validated
   */
  maxAwakeDeadlineMinutes: number | null;
  /** where workstation data survives sleep */
  persistence: PersistenceMode;
  /** how the ACP agent port is published */
  exposure: ExposureMode;
  /** where list finds workstations without waking them */
  discovery: DiscoverySource;
  /** changing the machine size restarts a running workstation to take effect */
  resizeRestarts: boolean;
}

/** one machine size a provider offers */
export interface MachineOffer {
  /** the provider's own name for the size, such as `shared-cpu-2x` */
  label: string;
  /** CPUs the size provides */
  cpus: number;
  /** memory the size provides, in whole gigabytes */
  memoryGb: number;
}

/** the smallest machine a workstation must run on */
export interface MachineRequirement {
  /** minimum CPUs */
  cpus: number;
  /** minimum memory, in whole gigabytes */
  memoryGb: number;
}

/** a driver selection combination a provider cannot host */
export interface ProfileIncompatibility {
  /** human-readable explanation reported by validation */
  reason: string;
  /**
   * tells whether this incompatibility applies to a profile
   * @param profile profile whose driver ids are all known to the catalog
   * @returns true when the provider cannot host the profile
   */
  appliesTo(profile: WorkstationProfile): boolean;
}

/** provider identity and capability axes, declared as data */
export interface ProviderDeclaration<
  Name extends string = string,
> extends DriverDescriptor<'providers', Name> {
  /** capability axes core and the idle governor branch on */
  capabilities: ProviderCapabilities;
  /** machine sizes the provider offers, cheapest first */
  machines: readonly MachineOffer[];
  /** combinations validation rejects before any provider call */
  incompatibilities: readonly ProfileIncompatibility[];
  /** host tools and credential every provider-reaching command needs */
  prerequisites: ProviderPrerequisites;
  /** guest login accounts the provider adds beside the agent account; they share its GitHub CLI login */
  shellAccounts: readonly string[];
  /** OS images the provider can create workstations from, the default first */
  images: readonly [OsImage, ...OsImage[]];
  /** who runs the guest services: the provider itself, or a backend setup installs */
  serviceBackend: ServiceBackendId;
  /** guest program each boot runs to restore what the provider resets; absent when the root disk persists */
  bootHook?: GuestAsset;
}

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

/** provider-neutral record of one managed workstation */
export interface WorkstationRecord {
  /** immutable provider identity */
  id: string;
  /** user-chosen workstation name */
  name: string;
  /** provider account or organization owning the workstation */
  organization: string;
  /** creation time as an ISO 8601 timestamp */
  createdAt?: string;
  /** provider-reported run state */
  state: string;
  /** machine size the workstation runs on, when the provider reports it */
  machine?: MachineOffer;
  /** canonical ACP agent URL when the provider assigned one */
  url?: string;
  /** ownership, schema, setup state and profile summary read without waking */
  metadata: WorkstationMetadata;
}

/** compact non-secret metadata a provider stores natively */
export interface WorkstationMetadata {
  /** provider-recorded progress of the current provisioning attempt */
  setup: WorkstationSetupState;
  /** compact profile summary; absent when the provider has none recorded */
  profile?: RecordedProfile;
}

/** provider-neutral failure surfaced instead of a provider SDK error */
export interface ProviderFailure extends Error {
  /** neutral failure class */
  code: ProviderErrorCode;
}

/** a provider: where the workstation runs and how it is reached */
export interface ProviderDriver<
  Name extends string = string,
> extends ProviderDeclaration<Name> {
  /**
   * guest module, in the provider's own guest folder and named `<name>-awake.js`,
   * whose exports apply the idle governor's decision on this provider: an
   * `AwakeDeadlineAdapter` for `native-deadline`, an `IdleFormAdapter` for
   * `governed`; undefined while the provider has none, and the governor then
   * calls no adapter and records only its state, with a diagnostic that the
   * provider declares no awake adapter, never an adapter failure
   */
  awakeAdapter: GuestPayload | undefined;
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
}

/** one compiled guest module a driver contributes to the deployable payload */
export interface GuestPayload {
  /** path relative to the compiled guest payload root */
  module: string;
  /** account that must be able to execute it */
  account: GuestAccount;
}

/** a process that speaks ACP on a harness's behalf */
export interface AcpAdapterSpec {
  /** the adapter as a tool, installed and upgraded with its harness */
  tool: ToolSpec;
  /** command the ACP agent runs to launch the adapter */
  launch: GuestCommand;
}

/** one named readiness observation */
export interface ReadinessFinding {
  /** human-readable check name */
  name: string;
  /** check outcome */
  status: ReadinessStatus;
}

/** CLIProxyAPI routing applied to a proxy-capable harness */
export interface ProxyRoute {
  /** hub base URL */
  url: string;
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

/** non-secret native harness configuration and authentication evidence */
export interface NativeHarnessInspection {
  /** the managed CLIProxyAPI gateway is configured */
  gatewayConfigured: boolean;
  /** native model discovery through the gateway is enabled */
  modelDiscoveryEnabled: boolean;
  /** the native plugin inventory command succeeded */
  pluginListAvailable: boolean;
  /** every exact idle-governor awake command the harness driver owns is installed in its hooks */
  awakeHooksInstalled: boolean;
  /** how the harness authenticates */
  authentication: 'managed-proxy' | 'native' | 'not-configured';
}

/** current native state of one harness, observed without a model turn */
export interface HarnessInspection<
  Evidence extends HarnessPluginEvidence | undefined =
    HarnessPluginEvidence | undefined,
> {
  /** non-secret configuration and authentication evidence */
  configuration: NativeHarnessInspection;
  /** plugin identities open-agent manages natively */
  selectedPlugins: string[];
  /** the native inventory confirms every selected plugin is installed and enabled */
  pluginsEnabled: boolean;
  /** probe evidence an ACP agent compares with what it loaded */
  evidence: Evidence;
}

/** facts the readiness checks of one harness depend on */
export interface HarnessReadinessContext {
  /** the workstation routes proxy-capable harnesses through CLIProxyAPI */
  proxy: boolean;
}

/** harness identity and capabilities, declared as data */
export interface HarnessDeclaration<
  Name extends string = string,
> extends DriverDescriptor<'harnesses', Name> {
  /** can route through CLIProxyAPI */
  supportsProxy: boolean;
  /** ACP adapter the harness provides, when it provides one */
  acpAdapter?: AcpAdapterSpec;
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
  /** environment the ACP agent passes when spawning the harness */
  spawnEnvironment: Readonly<Record<string, string>>;
  /** model-gateway variables the harness owns, which a runtime environment must not override */
  reservedEnvironment: readonly string[];
  /** compiled guest modules the harness contributes to the deployable payload */
  guest: readonly GuestPayload[];
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

/** short-lived pairing credential an ACP agent issues */
export interface AgentPairing {
  /** pairing secret; never logged */
  token: string;
  /** expiry as an ISO 8601 timestamp */
  expiresAt?: string;
}

/** one release channel an agent can be installed and kept updated from */
export interface ReleaseChannel {
  /** the name a user selects, such as `stable` */
  id: string;
  /** the npm dist-tag the agent's package is installed and updated from */
  distTag: string;
}

/** an ordered set of release channels and the one chosen when none is selected */
export interface ReleaseChannels {
  /** the channels in menu order */
  channels: readonly ReleaseChannel[];
  /** the identifier of the channel selected by default; one of the channels */
  defaultChannel: string;
}

/** ACP agent identity and capabilities, declared as data */
export interface AgentDeclaration<
  Name extends string = string,
  HarnessName extends string = string,
> extends DriverDescriptor<'agents', Name> {
  /** harnesses the agent can drive; filters the harness menu */
  supportedHarnesses: readonly HarnessName[];
  /** what the agent launches per harness */
  harnessLaunchMode: HarnessLaunchMode;
  /** can issue a pairing code */
  supportsPairing: boolean;
  /** release channels the agent installs from; absent when it has one */
  releaseChannels?: ReleaseChannels;
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
  /** npm packages the agent's guest modules import, installed beside it */
  guestPackages: readonly string[];
  /** compiled guest modules the agent contributes to the deployable payload */
  guest: readonly GuestPayload[];
  /** command, account, public port and dependencies on nothing; core adds the network daemon */
  service: ServiceDefinition;
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
