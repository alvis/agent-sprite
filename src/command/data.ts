import type { CommandErrorCode } from '#command/contracts';
import type { HarnessId, ProviderId } from '#core/catalog';
import type { WorkstationProfile } from '#core/profile';
import type { CreatePreflight } from '#create/types';
import type {
  CredentialSaveResult,
  ManagementCredentialName,
} from '#integrations/credentials';
import type { GuestEnvironment } from '#integrations/guest/environment';
import type { GuestInspection } from '#integrations/guest/runtime';
import type { UpdateStatus } from '#integrations/guest/updates';
import type { MachineSummary } from '#machine';
import type { ReadinessAssessment } from '#readiness';
import type { PairingSecret } from '#utilities/pairing-secret';

/** pairing metadata with explicitly marked disclosure material */
export interface PairingData {
  status: 'created' | 'failed' | 'not requested';
  expiresAt?: string;
  token?: PairingSecret;
  reason?: string;
  retry?: string;
}

/** current service state without executable arguments */
export interface ServiceSummary {
  name: string;
  state?: string;
}

/** successful creation with verified preflight and current guest evidence */
export interface CreateData {
  retainedCredentials?: Partial<
    Record<ManagementCredentialName, CredentialSaveResult>
  >;
  machine: MachineSummary;
  preflight: CreatePreflight;
  /** driver selection and options the workstation recorded */
  profile: WorkstationProfile;
  readiness: ReadinessAssessment;
  network: GuestInspection['network'];
  hub: GuestInspection['hub'];
  services: ServiceSummary[];
  native: GuestInspection['native'];
  pairing: PairingData;
}

/** live control-plane list merged across every provider with credentials */
/** a provider list could not query, with the normalized failure code */
export interface UnavailableProvider {
  /** provider that could not be queried */
  provider: ProviderId;
  /** failure class, such as AUTH for a revoked credential */
  code: CommandErrorCode;
  /** redacted reason */
  reason: string;
}

export interface ListData {
  machines: Array<MachineSummary & { provider: ProviderId }>;
  /** providers that could not be queried, with the reason */
  unavailable: UnavailableProvider[];
}

/** selected workstation and explicitly requested inspection or local action */
export interface ShowData {
  machine: MachineSummary;
  inspection?: GuestInspection & { readiness?: ReadinessAssessment };
  pairing?: PairingData;
  action?: 'copy';
}

/** readiness evidence retained even when the workstation is not ready */
export interface CurrentReadiness extends ReadinessAssessment {
  network: GuestInspection['network'];
  hub: GuestInspection['hub'];
  native: GuestInspection['native'];
  services: ServiceSummary[];
  environment: GuestInspection['environment'];
  updates?: UpdateStatus;
  governor: GuestInspection['governor'];
}

/** bounded doctor inspection result */
export interface DoctorData {
  machine: MachineSummary;
  currentReadiness: CurrentReadiness;
}

/** completed workstation deletion and separately observed network cleanup */
export interface TerminateData {
  machine: MachineSummary;
  workstation: { status: 'deleted'; id: string; name: string };
  network: {
    status:
      | 'no device identity recorded'
      | 'cleanup required'
      | 'deleted'
      | 'cleanup failed';
    deviceId?: string;
    address?: string;
  };
}

/** native agent setup or explicitly requested pairing */
export interface AgentSetupData {
  service?: 'configured';
  pairing: PairingData;
}

/** selected native networking outcome */
export interface NetworkSetupData {
  network:
    | { status: 'configured'; exitNode?: string }
    | { status: 'disabled'; readiness: 'skipped' };
}

/** native GitHub authentication outcome */
export interface GithubSetupData {
  github: 'configured' | 'preserved' | 'skipped';
}

/** native Git identity outcome */
export interface GitSetupData {
  gitIdentity: 'configured' | 'preserved';
}

/** selected native gateway outcome */
export interface ProxySetupData {
  proxy: { status: 'configured'; baseUrl?: string } | { status: 'disabled' };
}

/** names of configured environment values without their secret contents */
export interface EnvironmentSetupData {
  runtimeEnvironment: { status: 'configured'; names: string[] };
}

/** selected plugin changes by native harness */
export interface PluginsSetupData {
  plugins: Record<HarnessId, 'applied' | 'preserved'>;
}

/** how many tools an update left current, did not run for, and failed */
export interface ComponentCounts {
  /** tools current after the update */
  installed: number;
  /** tools the update did not run for */
  skipped: number;
  /** tools whose update failed */
  failed: number;
}

/** tool mutation, an update schedule change, or recorded installation facts */
export interface ToolsSetupData {
  /** what the update did to the managed tools, when it recorded it */
  components?: ComponentCounts;
  tools:
    | 'updated'
    | 'scheduled'
    | 'unchanged'
    | {
        status: 'recorded versions';
        /** the installed tools environment.json records */
        tools: GuestEnvironment['tools'];
        /** the optional tools setup skipped */
        skipped: GuestEnvironment['setup']['skipped'];
        /** what the last update recorded, when one ran */
        lastUpdate?: UpdateStatus;
      };
}

/** all-section recovery retains each independently selected outcome */
export interface AllSetupData
  extends
    Partial<AgentSetupData>,
    Partial<GithubSetupData>,
    Partial<GitSetupData>,
    Partial<EnvironmentSetupData>,
    Partial<PluginsSetupData>,
    NetworkSetupData,
    ProxySetupData,
    ToolsSetupData {}

/** concrete outcomes keyed by the executed guest setup section */
export interface SetupSectionData {
  all: AllSetupData;
  agent: AgentSetupData;
  network: NetworkSetupData;
  github: GithubSetupData;
  git: GitSetupData;
  proxy: ProxySetupData;
  env: EnvironmentSetupData;
  plugins: PluginsSetupData;
  tools: ToolsSetupData;
}

/** section identity stays correlated with its concrete result */
export type AppliedSetupSection = {
  [Section in keyof SetupSectionData]: {
    section: Section;
  } & SetupSectionData[Section];
}[keyof SetupSectionData];

/** caller-side credential storage has no workstation identity */
export interface LocalCredentialData {
  localCredential: {
    status: 'unchanged' | 'replaced';
    scope: 'this computer; all workstations';
    storage?: CredentialSaveResult['storage'];
    fallbackReason?: NonNullable<CredentialSaveResult['fallbackReason']>;
  };
}

/** setup can configure one guest or replace the shared local credential */
export type SetupData =
  | (AppliedSetupSection & {
      machine: MachineSummary;
      retainedCredentials?: Partial<
        Record<ManagementCredentialName, CredentialSaveResult>
      >;
    })
  | LocalCredentialData;

/** success payload for each executed command */
export interface CommandData {
  create: CreateData;
  setup: SetupData;
  list: ListData;
  show: ShowData;
  terminate: TerminateData;
  doctor: DoctorData;
}

/** failed creation can still preserve verified preflight facts */
export interface CreateFailureData {
  preflight: CreatePreflight;
  readiness?: ReadinessAssessment;
  setup?: 'ready';
  recovery?: {
    privacy: 'confirmed' | 'unconfirmed';
    incompleteLabel: 'confirmed' | 'unconfirmed';
  };
}

/** typed observations that remain meaningful after failure */
export interface CommandFailureData {
  create: CreateFailureData;
  setup: {
    readiness?: ReadinessAssessment;
    recovery?: { incompleteLabel: 'confirmed' | 'unconfirmed' };
  };
  list: never;
  show: never;
  terminate: TerminateData;
  doctor: DoctorData;
}
