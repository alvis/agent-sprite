import { each, mapValues, projectFields, same } from './fields';

import type { ServiceSummary } from '#application/data';
import type { T3Environment } from '#domain/observations/agent';
import type { BootReport } from '#domain/observations/boot';
import type {
  GovernorReport,
  GovernorState,
} from '#domain/observations/governor';
import type { NativeHarnessInspection } from '#domain/observations/harness';
import type { HubStatus } from '#domain/observations/hub';
import type {
  HarnessAgentState,
  NativeConfigurationInspection,
} from '#domain/observations/native';
import type { NetworkStatus } from '#domain/observations/network';
import type {
  UpdateStatus,
  UpdateToolOutcome,
} from '#domain/observations/updates';
import type { GuestServiceState } from '#domain/services';

import type { EnvironmentOutput } from './environment';
import type { ProbeFailureOutput } from './readiness';

/** current state of one service on the guest */
export interface GuestServiceOutput {
  name: string;
  status?: string;
  needs: readonly string[];
  startedAt?: string;
}

/** current service state without executable arguments */
export interface ServiceSummaryOutput {
  name: string;
  state?: string;
}

/** what the guest network reports */
export interface NetworkOutput {
  deviceId?: string;
  ip?: string;
  online: boolean;
  skipped: boolean;
  reason?: string;
  exitNode?: string;
  exitNodeIp?: string;
  exitNodeName?: string;
  routeDevice?: string;
  dnsReady?: boolean;
  egressIp?: string;
}

/** whether the gateway answered */
export interface HubOutput {
  reachable: boolean;
  skipped: boolean;
  status?: number;
  reason?: string;
}

/** native configuration of one harness */
export interface NativeHarnessOutput {
  gatewayConfigured: boolean;
  modelDiscoveryEnabled: boolean;
  pluginListAvailable: boolean;
  awakeHooksInstalled: boolean;
  authentication: string;
}

/** the agent environment the guest reports */
export type AgentEnvironmentOutput =
  | {
      ok: true;
      serverVersion: string;
      label?: string;
      orchestrationProtocolVersion?: number;
    }
  | { ok: false; reason: string };

/** plugins selected for a harness and the evidence the guest observed */
export interface HarnessStateOutput {
  selectedPlugins: readonly string[];
  /** evidence the guest observed, passed through as recorded */
  evidence: unknown;
}

/** native configuration the guest reports, by harness */
export interface NativeOutput {
  claude?: NativeHarnessOutput;
  codex?: NativeHarnessOutput;
  agentEnvironment?: AgentEnvironmentOutput;
  harnesses: Record<string, HarnessStateOutput>;
}

/** the last update run */
export interface UpdateStatusOutput {
  startedAt?: string;
  finishedAt?: string;
  lastSuccess?: string;
  tools: Array<{
    name: string;
    manager: string;
    required: boolean;
    outcome: string;
    from?: string;
    to?: string;
    reason?: string;
  }>;
}

/** the keep-awake governor state, when the guest recorded one */
export type GovernorOutput =
  | { recorded: true; state: Record<string, unknown> }
  | { recorded: false; reason: string };

/** the boot report of the guest */
export interface BootOutput {
  status?: string;
  startedAt?: string;
  durationMs?: number;
  unsuccessfulSteps: Readonly<Record<string, string>>;
  log: readonly string[];
}

/** everything a guest inspection observed */
export interface InspectionOutput {
  services: GuestServiceOutput[];
  network: NetworkOutput;
  native?: NativeOutput;
  hub: HubOutput;
  environment: EnvironmentOutput;
  updates?: UpdateStatusOutput;
  probeFailures: ProbeFailureOutput[];
  governor: GovernorOutput;
  boot?: BootOutput;
}

type RecordedHold = GovernorState['holds'][number];
type AdapterResult = NonNullable<GovernorState['adapter']>;

/**
 * projects the state of one guest service
 * @param service internal state
 * @returns output state
 */
export function projectGuestService(
  service: GuestServiceState,
): GuestServiceOutput {
  return projectFields<GuestServiceState, GuestServiceOutput>(service, {
    name: same,
    status: same,
    needs: same,
    startedAt: same,
  });
}

/**
 * projects a service name and state
 * @param service internal summary
 * @returns output summary
 */
export function projectServiceSummary(
  service: ServiceSummary,
): ServiceSummaryOutput {
  return projectFields<ServiceSummary, ServiceSummaryOutput>(service, {
    name: same,
    state: same,
  });
}

/**
 * projects the guest network state
 * @param network internal state
 * @returns output state
 */
export function projectNetworkStatus(network: NetworkStatus): NetworkOutput {
  return projectFields<NetworkStatus, NetworkOutput>(network, {
    deviceId: same,
    ip: same,
    online: same,
    skipped: same,
    reason: same,
    exitNode: same,
    exitNodeIp: same,
    exitNodeName: same,
    routeDevice: same,
    dnsReady: same,
    egressIp: same,
  });
}

/**
 * projects the gateway state
 * @param hub internal state
 * @returns output state
 */
export function projectHub(hub: HubStatus): HubOutput {
  return projectFields<HubStatus, HubOutput>(hub, {
    reachable: same,
    skipped: same,
    status: same,
    reason: same,
  });
}

/**
 * projects the native configuration of a harness
 * @param native internal inspection
 * @returns output inspection
 */
function projectNativeHarness(
  native: NativeHarnessInspection,
): NativeHarnessOutput {
  return projectFields<NativeHarnessInspection, NativeHarnessOutput>(native, {
    gatewayConfigured: same,
    modelDiscoveryEnabled: same,
    pluginListAvailable: same,
    awakeHooksInstalled: same,
    authentication: same,
  });
}

/**
 * projects the agent environment the guest reports
 * @param environment internal environment
 * @returns output environment
 */
function projectAgentEnvironment(
  environment: T3Environment,
): AgentEnvironmentOutput {
  return environment.ok
    ? projectFields<typeof environment, AgentEnvironmentOutput>(environment, {
        ok: same,
        serverVersion: same,
        label: same,
        orchestrationProtocolVersion: same,
      })
    : projectFields<typeof environment, AgentEnvironmentOutput>(environment, {
        ok: same,
        reason: same,
      });
}

/**
 * projects the plugins selected for a harness
 * @param state internal state
 * @returns output state
 */
function projectHarnessState(state: HarnessAgentState): HarnessStateOutput {
  return projectFields<HarnessAgentState, HarnessStateOutput>(state, {
    selectedPlugins: same,
    evidence: same,
  });
}

/**
 * projects the native configuration the guest reports
 * @param native internal inspection
 * @returns output inspection
 */
export function projectNative(
  native: NativeConfigurationInspection,
): NativeOutput {
  return projectFields<NativeConfigurationInspection, NativeOutput>(native, {
    claude: projectNativeHarness,
    codex: projectNativeHarness,
    agentEnvironment: projectAgentEnvironment,
    harnesses: mapValues(projectHarnessState),
  });
}

/**
 * projects the last update run
 * @param updates internal status
 * @returns output status
 */
export function projectUpdates(updates: UpdateStatus): UpdateStatusOutput {
  return projectFields<UpdateStatus, UpdateStatusOutput>(updates, {
    startedAt: same,
    finishedAt: same,
    lastSuccess: same,
    tools: each((tool) =>
      projectFields<UpdateToolOutcome, UpdateStatusOutput['tools'][number]>(
        tool,
        {
          name: same,
          manager: same,
          required: same,
          outcome: same,
          from: same,
          to: same,
          reason: same,
        },
      ),
    ),
  });
}

/**
 * projects the governor state the guest recorded
 * @param state internal state
 * @returns output state
 */
function projectGovernorState(state: GovernorState): Record<string, unknown> {
  return projectFields<GovernorState, Record<string, unknown>>(state, {
    version: same,
    updatedAt: same,
    keepAwakeMode: same,
    idleTimeoutMinutes: same,
    holdMaxMinutes: same,
    lastHeartbeat: same,
    holds: each((hold: RecordedHold) =>
      projectFields<RecordedHold, Record<string, unknown>>(hold, {
        source: same,
        session: same,
        expiresAt: same,
      }),
    ),
    openHolds: same,
    deadline: same,
    sleepPermitted: same,
    adapter: (adapter: AdapterResult) =>
      projectFields<AdapterResult, Record<string, unknown>>(adapter, {
        at: same,
        action: same,
        result: same,
        failure: same,
      }),
    diagnostics: same,
  });
}

/**
 * projects the governor report
 * @param report internal report
 * @returns output report
 */
export function projectGovernor(report: GovernorReport): GovernorOutput {
  return report.recorded
    ? projectFields<typeof report, GovernorOutput>(report, {
        recorded: same,
        state: projectGovernorState,
      })
    : projectFields<typeof report, GovernorOutput>(report, {
        recorded: same,
        reason: same,
      });
}

/**
 * projects the boot report
 * @param boot internal report
 * @returns output report
 */
export function projectBoot(boot: BootReport): BootOutput {
  return projectFields<BootReport, BootOutput>(boot, {
    status: same,
    startedAt: same,
    durationMs: same,
    unsuccessfulSteps: same,
    log: same,
  });
}
