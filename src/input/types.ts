import type {
  CredentialSaveResult,
  ManagementCredentialName,
} from '#integrations/credentials';
import type { GuestIntegrations } from '#integrations/guest/types';

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
  spritesToken?: string;
  tailscaleApiKey?: string;
  tailnet?: string;
  tailscaleAuthKey?: string;
  exitNode?: string;
  proxyUrl?: string;
  proxyApiKey?: string;
  githubToken?: string;
  gitIdentity?: GitIdentity;
  integrations: GuestIntegrations;
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
  | 'spritesToken'
  | 'tailscaleEnrollment'
  | 'tailnet'
  | 'exitNode'
  | 'proxyUrl'
  | 'proxyApiKey'
  | 'gitIdentity'
  | 'githubToken';
