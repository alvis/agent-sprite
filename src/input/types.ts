import type { WorkstationProfile } from '#core/profile';
import type {
  CredentialSaveResult,
  ManagementCredentialName,
} from '#integrations/credentials';

/** commit identities are independent of optional GitHub authentication */
export interface GitIdentity {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

/** resolved create/setup values. Management credentials must remain on the caller */
export interface ResolvedInputs {
  name?: string;
  /** management credential of the selected provider */
  providerToken?: string;
  /** the provider credential was entered at a prompt in this run and is not saved yet */
  isProviderTokenEntered?: boolean;
  /** management credential of the selected network */
  networkKey?: string;
  /** account or network the network management credential manages */
  networkAccount?: string;
  /** single-use network enrollment credential */
  enrollmentKey?: string;
  /** exit node selector */
  exitNode?: string;
  proxyUrl?: string;
  proxyApiKey?: string;
  githubToken?: string;
  gitIdentity?: GitIdentity;
  /** driver selection and options this run resolved */
  profile: WorkstationProfile;
  runtimeEnv: Record<string, string>;
  sources: Record<string, string>;
  missing: string[];
  retainedCredentials?: Partial<
    Record<ManagementCredentialName, CredentialSaveResult>
  >;
}

/** inputs a workflow needs before its first remote mutation */
export type RequiredInput =
  | 'name'
  | 'providerToken'
  | 'networkEnrollment'
  | 'networkAccount'
  | 'exitNode'
  | 'proxyUrl'
  | 'proxyApiKey'
  | 'gitIdentity'
  | 'githubToken';
