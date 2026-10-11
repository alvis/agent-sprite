import type { CreatePreflight } from '#create/types';
import type {
  CredentialSaveResult,
  ManagementCredentialName,
} from '#integrations/credentials';
import type { GuestInspection } from '#integrations/guest/runtime';
import type { GuestManifest } from '#integrations/guest/types';
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
  integrations: GuestInspection['integrations'];
  readiness: ReadinessAssessment;
  tailscale: GuestInspection['tailscale'];
  hub: GuestInspection['hub'];
  services: ServiceSummary[];
  native: GuestInspection['native'];
  pairing: PairingData;
}

/** live control-plane list */
export interface ListData {
  machines: MachineSummary[];
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
  tailscale: GuestInspection['tailscale'];
  hub: GuestInspection['hub'];
  native: GuestInspection['native'];
  services: ServiceSummary[];
  manifest: GuestManifest;
}

/** bounded doctor inspection result */
export interface DoctorData {
  machine: MachineSummary;
  currentReadiness: CurrentReadiness;
}

/** completed Sprite deletion and separately observed tailnet cleanup */
export interface TerminateData {
  machine: MachineSummary;
  sprite: { status: 'deleted'; id: string; name: string };
  tailnet: {
    status:
      | 'no device identity recorded'
      | 'cleanup required'
      | 'deleted'
      | 'cleanup failed';
    deviceId?: string;
    tailnetIp?: string;
  };
}

/** native T3 setup or explicitly requested pairing */
export interface T3SetupData {
  service?: 'configured';
  pairing: PairingData;
}

/** selected native networking outcome */
export interface TailscaleSetupData {
  tailscale:
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
  plugins: { claude: 'applied' | 'preserved'; codex: 'applied' | 'preserved' };
}

/** tool mutation or recorded installation facts */
export interface ToolsSetupData {
  tools:
    | 'updated'
    | 'unchanged'
    | {
        status: 'recorded versions';
        installedVersions: GuestManifest['installedVersions'];
        lastSuccessfulUpdate: GuestManifest['lastSuccessfulUpdate'];
      };
}

/** all-section recovery retains each independently selected outcome */
export interface AllSetupData
  extends
    Partial<T3SetupData>,
    Partial<GithubSetupData>,
    Partial<GitSetupData>,
    Partial<EnvironmentSetupData>,
    Partial<PluginsSetupData>,
    TailscaleSetupData,
    ProxySetupData,
    ToolsSetupData {}

/** concrete outcomes keyed by the executed guest setup section */
export interface SetupSectionData {
  all: AllSetupData;
  t3: T3SetupData;
  tailscale: TailscaleSetupData;
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
