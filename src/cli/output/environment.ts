import { each, projectFields, same } from './fields';
import { projectProfile } from './profile';

import type {
  EnvironmentHarness,
  EnvironmentNetwork,
  EnvironmentProvider,
  EnvironmentTool,
  GuestEnvironment,
  SkippedTool,
} from '#domain/observations/environment';
import type { GuestNetworkIdentity } from '#domain/observations/network';
import type { PeriodicJob, ServiceDefinition } from '#domain/services';

import type { ProfileOutput } from './profile';

/** a command as a guest declaration records it */
export interface EnvironmentCommandOutput {
  program: string;
  arguments: readonly string[];
  account?: string;
  environment?: Readonly<Record<string, string>>;
}

/** a tool the guest records as installed */
export interface EnvironmentToolOutput {
  name: string;
  required: boolean;
  account: string;
  executables: readonly string[];
  /** how the tool is installed; a declaration, passed through as recorded */
  source: unknown;
  /** the version its manager reported installed when it was last recorded */
  version?: string;
}

/** an optional tool setup did not install */
export interface SkippedToolOutput {
  name: string;
  reason: string;
}

/** provider behavior the guest recorded */
export interface EnvironmentProviderOutput {
  id: string;
  serviceBackend: string;
  keepAwakeMode: string;
  idleForms: readonly string[];
  wakeMode: string;
  supportsCliWakeSleep: boolean;
  maxAwakeDeadlineMinutes: number | null;
  transportNetworks: readonly string[];
  idleTimeoutMinutes: number;
  holdMaxMinutes: number;
  awakeAdapter: string | null;
}

/** a harness the guest recorded for its agent */
export interface EnvironmentHarnessOutput {
  id: string;
  environment: Readonly<Record<string, string>>;
  adapter?: { tool: string; launch: EnvironmentCommandOutput };
}

/** the agent the guest recorded */
export interface EnvironmentAgentOutput {
  id: string;
  service: string;
  account: string;
  port: number;
  harnesses: EnvironmentHarnessOutput[];
}

/** the network the guest recorded */
export interface EnvironmentNetworkOutput {
  id: string;
  daemon: string;
  launcher: { stateDirectory: string; socket: string; tun: string };
}

/** a service the guest runs */
export interface ServiceDefinitionOutput {
  name: string;
  command: string;
  arguments: readonly string[];
  account: string;
  needs: readonly string[];
  httpPort?: number;
  machineLog?: boolean;
}

/** a periodic job the guest runs */
export interface PeriodicJobOutput {
  name: string;
  everyMinutes: number;
  run: { command: string; arguments: readonly string[]; account: string };
}

/** the identity the network assigned to the guest */
export interface NetworkIdentityOutput {
  network: string;
  deviceId?: string;
  ip?: string;
}

/** the environment record the guest wrote at setup */
export interface EnvironmentOutput {
  schema: number;
  openAgent: { version: string; setupAt: string };
  setup: { state: string; skipped: SkippedToolOutput[] };
  os: { family: string };
  profile: ProfileOutput;
  tools: EnvironmentToolOutput[];
  schedule: { dueDays: number };
  provider: EnvironmentProviderOutput;
  agent: EnvironmentAgentOutput;
  network: EnvironmentNetworkOutput | null;
  services: ServiceDefinitionOutput[];
  jobs: PeriodicJobOutput[];
  networkIdentity?: NetworkIdentityOutput;
}

type EnvironmentAgent = GuestEnvironment['agent'];
type EnvironmentCommand = NonNullable<EnvironmentHarness['adapter']>['launch'];

/**
 * projects a recorded command
 * @param command internal command
 * @returns output command
 */
function projectCommand(command: EnvironmentCommand): EnvironmentCommandOutput {
  return projectFields<EnvironmentCommand, EnvironmentCommandOutput>(command, {
    program: same,
    arguments: same,
    account: same,
    environment: same,
  });
}

/**
 * projects a recorded harness
 * @param harness internal harness
 * @returns output harness
 */
function projectHarness(harness: EnvironmentHarness): EnvironmentHarnessOutput {
  return projectFields<EnvironmentHarness, EnvironmentHarnessOutput>(harness, {
    id: same,
    environment: same,
    adapter: (adapter) =>
      projectFields<typeof adapter, { tool: string; launch: unknown }>(
        adapter,
        { tool: same, launch: projectCommand },
      ),
  });
}

/**
 * projects the recorded agent
 * @param agent internal agent
 * @returns output agent
 */
function projectAgent(agent: EnvironmentAgent): EnvironmentAgentOutput {
  return projectFields<EnvironmentAgent, EnvironmentAgentOutput>(agent, {
    id: same,
    service: same,
    account: same,
    port: same,
    harnesses: each(projectHarness),
  });
}

/**
 * projects the recorded network
 * @param network internal network
 * @returns output network
 */
function projectNetwork(network: EnvironmentNetwork): EnvironmentNetworkOutput {
  return projectFields<EnvironmentNetwork, EnvironmentNetworkOutput>(network, {
    id: same,
    daemon: same,
    launcher: (launcher) =>
      projectFields<typeof launcher, EnvironmentNetworkOutput['launcher']>(
        launcher,
        { stateDirectory: same, socket: same, tun: same },
      ),
  });
}

/**
 * projects a recorded tool
 * @param tool internal tool
 * @returns output tool
 */
export function projectTool(tool: EnvironmentTool): EnvironmentToolOutput {
  return projectFields<EnvironmentTool, EnvironmentToolOutput>(tool, {
    name: same,
    required: same,
    account: same,
    executables: same,
    source: same,
    version: same,
  });
}

/**
 * projects a tool setup skipped
 * @param tool internal skipped tool
 * @returns output skipped tool
 */
export function projectSkippedTool(tool: SkippedTool): SkippedToolOutput {
  return projectFields<SkippedTool, SkippedToolOutput>(tool, {
    name: same,
    reason: same,
  });
}

/**
 * projects recorded provider behavior
 * @param provider internal provider record
 * @returns output provider record
 */
function projectProvider(
  provider: EnvironmentProvider,
): EnvironmentProviderOutput {
  return projectFields<EnvironmentProvider, EnvironmentProviderOutput>(
    provider,
    {
      id: same,
      serviceBackend: same,
      keepAwakeMode: same,
      idleForms: same,
      wakeMode: same,
      supportsCliWakeSleep: same,
      maxAwakeDeadlineMinutes: same,
      transportNetworks: same,
      idleTimeoutMinutes: same,
      holdMaxMinutes: same,
      awakeAdapter: same,
    },
  );
}

/**
 * projects a service definition
 * @param service internal definition
 * @returns output definition
 */
function projectServiceDefinition(
  service: ServiceDefinition,
): ServiceDefinitionOutput {
  return projectFields<ServiceDefinition, ServiceDefinitionOutput>(service, {
    name: same,
    command: same,
    arguments: same,
    account: same,
    needs: same,
    httpPort: same,
    machineLog: same,
  });
}

/**
 * projects a periodic job
 * @param job internal job
 * @returns output job
 */
function projectJob(job: PeriodicJob): PeriodicJobOutput {
  return projectFields<PeriodicJob, PeriodicJobOutput>(job, {
    name: same,
    everyMinutes: same,
    run: (run) =>
      projectFields<typeof run, PeriodicJobOutput['run']>(run, {
        command: same,
        arguments: same,
        account: same,
      }),
  });
}

/**
 * projects the network identity
 * @param identity internal identity
 * @returns output identity
 */
function projectNetworkIdentity(
  identity: GuestNetworkIdentity,
): NetworkIdentityOutput {
  return projectFields<GuestNetworkIdentity, NetworkIdentityOutput>(identity, {
    network: same,
    deviceId: same,
    ip: same,
  });
}

/**
 * projects the environment record of a guest
 * @param environment internal environment
 * @returns output environment
 */
export function projectEnvironment(
  environment: GuestEnvironment,
): EnvironmentOutput {
  return projectFields<GuestEnvironment, EnvironmentOutput>(environment, {
    schema: same,
    openAgent: (openAgent) =>
      projectFields<typeof openAgent, EnvironmentOutput['openAgent']>(
        openAgent,
        {
          version: same,
          setupAt: same,
        },
      ),
    setup: (setup) =>
      projectFields<typeof setup, EnvironmentOutput['setup']>(setup, {
        state: same,
        skipped: each(projectSkippedTool),
      }),
    os: (os) =>
      projectFields<typeof os, EnvironmentOutput['os']>(os, { family: same }),
    profile: projectProfile,
    tools: each(projectTool),
    schedule: (schedule) =>
      projectFields<typeof schedule, EnvironmentOutput['schedule']>(schedule, {
        dueDays: same,
      }),
    provider: projectProvider,
    agent: projectAgent,
    network: (network) => (network === null ? null : projectNetwork(network)),
    services: each(projectServiceDefinition),
    jobs: each(projectJob),
    networkIdentity: projectNetworkIdentity,
  });
}
