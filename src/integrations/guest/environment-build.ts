import { environmentProblem } from './environment-validation.js';
import { ENVIRONMENT_SCHEMA } from './environment.js';

import type { WorkstationProfile } from '#core/profile';
import type { AcpAdapterSpec, ProviderDeclaration } from '#drivers/contracts';
import type { ServiceDefinition } from '#drivers/guest-channel';
import type { PeriodicJob } from '#os/contracts';
import type {
  Resolution,
  ToolOwner,
  ToolSource,
  ToolSpec,
} from '#tools/contracts';

import type {
  EnvironmentHarness,
  EnvironmentNetwork,
  EnvironmentProvider,
  EnvironmentSetupState,
  EnvironmentTool,
  GuestEnvironment,
  SkippedTool,
} from './environment.js';
import type { GuestNetworkIdentity } from './types.js';

/** what {@link buildEnvironment} records */
export interface EnvironmentParams {
  /** the running open-agent version */
  version: string;
  /** when setup finished, as an ISO 8601 timestamp */
  setupAt: string;
  /** how setup ended */
  state: EnvironmentSetupState;
  /** the workstation's profile */
  profile: WorkstationProfile;
  /** the selected provider */
  provider: Pick<
    ProviderDeclaration,
    'id' | 'capabilities' | 'serviceBackend' | 'awakeAsset'
  >;
  /** every tool setup resolved */
  tools: readonly ToolSpec[];
  /** the source picked for each tool, or why none is usable */
  resolutions: readonly Resolution[];
  /** the selected agent and its service, as the backend runs it */
  agent: {
    /** agent identifier */
    id: string;
    /** the agent's service */
    service: ServiceDefinition;
  };
  /** the selected harnesses, in selection order */
  harnesses: ReadonlyArray<{
    /** harness identifier */
    id: string;
    /** environment the agent passes when spawning the harness */
    spawnEnvironment: Readonly<Record<string, string>>;
    /** the ACP adapter the harness provides */
    acpAdapter?: AcpAdapterSpec;
  }>;
  /** the selected network's launch facts; null when it runs no daemon */
  network: EnvironmentNetwork | null;
  /** the services the backend runs */
  services: readonly ServiceDefinition[];
  /** the commands the backend runs on a schedule */
  jobs: readonly PeriodicJob[];
  /** the retained network device identity */
  networkIdentity?: GuestNetworkIdentity;
}

/**
 * builds the environment record from the selection and what setup resolved;
 * a tool without a usable source is recorded as skipped, and the idle settings
 * are capped at the furthest the provider can keep the workstation awake
 * @param params version, outcome, selection, tools, services and jobs
 * @returns the record, validated
 * @throws {Error} when a resolution names an undeclared tool, the agent
 * publishes no port, or the record is inconsistent
 */
export function buildEnvironment(params: EnvironmentParams): GuestEnvironment {
  const { profile, agent, networkIdentity } = params;
  const { httpPort } = agent.service;
  if (httpPort === undefined) {
    throw new Error(`Agent ${agent.id} publishes no port`);
  }
  const { tools, skipped } = recordTools(params.tools, params.resolutions);
  const environment: GuestEnvironment = {
    schema: ENVIRONMENT_SCHEMA,
    openAgent: { version: params.version, setupAt: params.setupAt },
    setup: { state: params.state, skipped },
    profile,
    tools,
    schedule: { dueDays: profile.options.updateDueIntervalDays },
    provider: providerFacts(params.provider, profile),
    agent: {
      id: agent.id,
      service: agent.service.name,
      account: agent.service.account,
      port: httpPort,
      harnesses: params.harnesses.map(harnessEntry),
    },
    network: params.network,
    services: params.services,
    jobs: params.jobs,
    ...(networkIdentity && { networkIdentity }),
  };
  const problem = environmentProblem(environment);
  if (problem) {
    throw new Error(`The guest environment is inconsistent: ${problem}`);
  }

  return environment;
}

/**
 * records each resolved tool with its source and owner, and each tool no
 * source of which is usable as skipped
 * @param specs every tool setup resolved
 * @param resolutions the source picked for each tool, or why none is usable
 * @returns the installed and the skipped tools
 * @throws {Error} when a resolution names an undeclared tool
 */
function recordTools(
  specs: readonly ToolSpec[],
  resolutions: readonly Resolution[],
): { tools: EnvironmentTool[]; skipped: SkippedTool[] } {
  const declared = new Map(specs.map((spec) => [spec.name, spec]));
  const tools: EnvironmentTool[] = [];
  const skipped: SkippedTool[] = [];
  for (const resolution of resolutions) {
    const spec = declared.get(resolution.tool);
    if (!spec) {
      throw new Error(`No tool ${resolution.tool} was declared`);
    }
    if ('unavailable' in resolution) {
      skipped.push({ name: spec.name, reason: resolution.unavailable });
    } else {
      tools.push({
        name: spec.name,
        required: spec.required,
        account: sourceOwner(resolution.source),
        executables: [...spec.executables],
        source: resolution.source,
      });
    }
  }

  return { tools, skipped };
}

/**
 * gathers the provider facts the governor reads, with the profile's idle
 * settings capped at the furthest one deadline keeps the workstation awake
 * @param provider the provider's id, capabilities and service backend
 * @param profile the profile whose idle settings are capped
 * @returns the facts the governor and the awake adapter read
 */
function providerFacts(
  provider: EnvironmentParams['provider'],
  profile: WorkstationProfile,
): EnvironmentProvider {
  const { capabilities } = provider;
  const cap = capabilities.maxAwakeDeadlineMinutes;
  const capped = (minutes: number): number =>
    cap === null ? minutes : Math.min(minutes, cap);

  return {
    id: provider.id,
    serviceBackend: provider.serviceBackend,
    keepAwakeMode: capabilities.keepAwakeMode,
    idleForms: [...capabilities.idleForms],
    wakeMode: capabilities.wakeMode,
    supportsCliWakeSleep: capabilities.supportsCliWakeSleep,
    maxAwakeDeadlineMinutes: cap,
    transportNetworks: [...capabilities.transportNetworks],
    idleTimeoutMinutes: capped(profile.options.idleTimeoutMinutes),
    holdMaxMinutes: capped(profile.options.holdMaxMinutes),
    awakeAdapter: provider.awakeAsset?.installAs ?? null,
  };
}

/**
 * names the account a source installs a tool as
 * @param source the resolved source
 * @returns `linuxbrew` for a formula, root for system packages, the agent for its own
 */
function sourceOwner(source: ToolSource): ToolOwner {
  switch (source.kind) {
    case 'brew':
      return 'linuxbrew';
    case 'system':
      return 'root';
    default:
      return source.account;
  }
}

/**
 * describes a harness for the agent's launcher
 * @param harness the harness's id, spawn environment and adapter
 * @param harness.id the id the launcher names it by
 * @param harness.spawnEnvironment environment the agent passes when spawning it
 * @param harness.acpAdapter the ACP adapter it provides
 * @returns its id, spawn environment and adapter launch, as recorded
 */
function harnessEntry(harness: {
  id: string;
  spawnEnvironment: Readonly<Record<string, string>>;
  acpAdapter?: AcpAdapterSpec;
}): EnvironmentHarness {
  const { id, spawnEnvironment, acpAdapter } = harness;

  return {
    id,
    environment: { ...spawnEnvironment },
    ...(acpAdapter && {
      adapter: {
        tool: acpAdapter.tool.name,
        launch: {
          program: acpAdapter.launch.program,
          arguments: [...acpAdapter.launch.arguments],
          ...(acpAdapter.launch.account && {
            account: acpAdapter.launch.account,
          }),
          ...(acpAdapter.launch.environment && {
            environment: { ...acpAdapter.launch.environment },
          }),
        },
      },
    }),
  };
}
