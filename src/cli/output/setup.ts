import { projectRetainedCredentials } from './credentials';
import { projectSkippedTool, projectTool } from './environment';
import { each, mapValues, projectFields, same } from './fields';
import { projectUpdates } from './inspection';
import { projectMachine } from './machine';
import { projectPairing } from './pairing';
import { projectReadiness } from './readiness';

import type {
  AllSetupData,
  AppliedSetupSection,
  CommandFailureData,
  ComponentCounts,
  LocalCredentialData,
  NetworkSetupData,
  SetupData,
  ToolsSetupData,
} from '#application/data';

import type { MachineSummary } from '#application/machine';
import type { CredentialSaveResult } from '#domain/credentials';

import type { RetainedCredentialsOutput } from './credentials';
import type { EnvironmentToolOutput, SkippedToolOutput } from './environment';
import type { UpdateStatusOutput } from './inspection';
import type { MachineOutput } from './machine';
import type { PairingOutput } from './pairing';
import type { ReadinessOutput } from './readiness';

/** how many tools an update left current, did not run for, and failed */
export interface ComponentCountsOutput {
  installed: number;
  skipped: number;
  failed: number;
}

/** the tools outcome: a verb, or the versions setup recorded */
export type ToolsSetupOutput =
  | string
  | {
      status: 'recorded versions';
      tools: EnvironmentToolOutput[];
      skipped: SkippedToolOutput[];
      lastUpdate?: UpdateStatusOutput;
    };

/** the outcome of a setup section, or of replacing the local credential */
export interface SetupDataOutput {
  section?: string;
  machine?: MachineOutput;
  retainedCredentials?: RetainedCredentialsOutput;
  service?: 'configured';
  pairing?: PairingOutput;
  network?:
    | { status: 'configured'; exitNode?: string }
    | { status: 'disabled'; readiness: 'skipped' };
  github?: string;
  gitIdentity?: string;
  proxy?: { status: 'configured'; baseUrl?: string } | { status: 'disabled' };
  runtimeEnvironment?:
    { status: 'configured'; names: readonly string[] } | { status: 'skipped' };
  plugins?: Record<string, string>;
  components?: ComponentCountsOutput;
  tools?: ToolsSetupOutput;
  localCredential?: {
    status: string;
    scope: string;
    storage?: string;
    fallbackReason?: string;
  };
}

/** what a failed setup still observed */
export interface SetupFailureDataOutput {
  readiness?: ReadinessOutput;
  recovery?: { incompleteLabel: 'confirmed' | 'unconfirmed' };
}

type SetupFields = Partial<
  AllSetupData &
    LocalCredentialData & {
      section: AppliedSetupSection['section'];
      machine: MachineSummary;
      retainedCredentials: Partial<Record<string, CredentialSaveResult>>;
    }
>;

type RecordedTools = Extract<ToolsSetupData['tools'], { status: string }>;

/**
 * projects the network setup outcome
 * @param network internal outcome
 * @returns output outcome
 */
function projectNetworkOutcome(
  network: NetworkSetupData['network'],
): NonNullable<SetupDataOutput['network']> {
  return network.status === 'configured'
    ? projectFields<typeof network, NonNullable<SetupDataOutput['network']>>(
        network,
        { status: same, exitNode: same },
      )
    : projectFields<typeof network, NonNullable<SetupDataOutput['network']>>(
        network,
        { status: same, readiness: same },
      );
}

/**
 * projects the tools outcome
 * @param tools internal outcome
 * @returns output outcome
 */
function projectToolsOutcome(tools: ToolsSetupData['tools']): ToolsSetupOutput {
  return typeof tools === 'string'
    ? tools
    : projectFields<RecordedTools, ToolsSetupOutput>(tools, {
        status: same,
        tools: each(projectTool),
        skipped: each(projectSkippedTool),
        lastUpdate: projectUpdates,
      });
}

/**
 * projects the update counts
 * @param counts internal counts
 * @returns output counts
 */
function projectComponents(counts: ComponentCounts): ComponentCountsOutput {
  return projectFields<ComponentCounts, ComponentCountsOutput>(counts, {
    installed: same,
    skipped: same,
    failed: same,
  });
}

/**
 * projects a setup outcome
 * @param data internal outcome, for one section or for the local credential
 * @returns output outcome
 */
export function projectSetup(data: SetupData): SetupDataOutput {
  return projectFields<SetupFields, SetupDataOutput>(data, {
    section: same,
    machine: projectMachine,
    retainedCredentials: projectRetainedCredentials,
    service: same,
    pairing: projectPairing,
    network: projectNetworkOutcome,
    github: same,
    gitIdentity: same,
    proxy: (proxy) =>
      proxy.status === 'configured'
        ? projectFields<typeof proxy, NonNullable<SetupDataOutput['proxy']>>(
            proxy,
            { status: same, baseUrl: same },
          )
        : projectFields<typeof proxy, NonNullable<SetupDataOutput['proxy']>>(
            proxy,
            { status: same },
          ),
    runtimeEnvironment: (environment) =>
      environment.status === 'configured'
        ? projectFields<
            typeof environment,
            NonNullable<SetupDataOutput['runtimeEnvironment']>
          >(environment, { status: same, names: same })
        : projectFields<
            typeof environment,
            NonNullable<SetupDataOutput['runtimeEnvironment']>
          >(environment, { status: same }),
    plugins: mapValues(same),
    components: projectComponents,
    tools: projectToolsOutcome,
    localCredential: (credential) =>
      projectFields<
        typeof credential,
        NonNullable<SetupDataOutput['localCredential']>
      >(credential, {
        status: same,
        scope: same,
        storage: same,
        fallbackReason: same,
      }),
  });
}

/**
 * projects what a failed setup still observed
 * @param data internal failure observations
 * @returns output failure observations
 */
export function projectSetupFailure(
  data: CommandFailureData['setup'],
): SetupFailureDataOutput {
  return projectFields<CommandFailureData['setup'], SetupFailureDataOutput>(
    data,
    {
      readiness: projectReadiness,
      recovery: (recovery) =>
        projectFields<
          typeof recovery,
          NonNullable<SetupFailureDataOutput['recovery']>
        >(recovery, { incompleteLabel: same }),
    },
  );
}
