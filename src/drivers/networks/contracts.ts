import type { Secret } from '#integrations/guest/session/secret';
import type { GuestAsset } from '#os/contracts';
import type { ToolSpec } from '#tools/contracts';

import type { DriverDescriptor, ReadinessFinding } from '../contracts';
import type {
  GuestChannel,
  GuestServiceState,
  ServiceDefinition,
} from '../guest-channel';

/** the program that prepares the guest for the network daemon and runs it, and where the daemon keeps its state */
export interface NetworkLauncher {
  /** the launcher, run as root */
  asset: GuestAsset;
  /** root-only directory on the persistent guest root holding the node identity and the managed resolver */
  stateDirectory: string;
  /** the daemon's control socket */
  socket: string;
  /** the tunnel interface */
  tun: string;
}

/** retained non-secret identity of an enrolled network device */
export interface NetworkIdentity {
  /** device identity at the network provider */
  deviceId?: string;
  /** network address of the device */
  ip?: string;
}

/** current private-network status of a workstation */
export interface NetworkStatus extends NetworkIdentity {
  /** whether the device is connected */
  online: boolean;
  /** whether the check was skipped because the network is not selected */
  skipped: boolean;
  /** bounded reason the status is unavailable */
  reason?: string;
  /** exit node the client currently routes through */
  exitNode?: string;
  /** IPv4 address of that exit node */
  exitNodeIp?: string;
  /** display name of that exit node */
  exitNodeName?: string;
  /** device the kernel routes public traffic through */
  routeDevice?: string;
  /** whether a public hostname resolved; reported by networks that route egress */
  dnsReady?: boolean;
  /** public IPv4 address observed from the guest */
  egressIp?: string;
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

/** one caller-side network input: where it is read from and how it is asked for */
interface NetworkInput {
  /** environment variable read from the process, selected env file or saved profile */
  environment: string;
  /** prompt shown when an interactive run still lacks the value */
  prompt: string;
}

/** caller-side inputs a network needs, declared as data */
export interface NetworkInputs {
  /** account or network that the management credential manages */
  account: NetworkInput;
  /** management credential and its local credential store entry */
  management: NetworkInput & { store: string };
  /** single-use enrollment credential that can replace the management credential */
  enrollment: Pick<NetworkInput, 'environment'>;
  /** exit node selector */
  exitNode: NetworkInput;
}

/** network identity and capabilities, declared as data */
export interface NetworkDeclaration<
  Name extends string = string,
> extends DriverDescriptor<'networks', Name> {
  /** can route egress through an exit node */
  supportsExitNode: boolean;
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
  /** caller-side inputs, read and prompted for by core; absent when the network takes none */
  inputs?: NetworkInputs;
  /** daemon service; the agent service depends on it when the network is selected; absent when the network runs no daemon */
  daemon?: ServiceDefinition;
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
