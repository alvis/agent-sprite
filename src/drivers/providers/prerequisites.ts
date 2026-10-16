/** a command-line tool a provider runs on the caller's computer */
export interface ToolPrerequisite {
  /** executable name looked up on PATH */
  command: string;
  /** lowest version whose behaviour the driver relies on, when one matters */
  minimumVersion?: string;
  /** arguments that print the version; --version when omitted */
  versionArguments?: readonly string[];
  /** how to install or upgrade the tool */
  fix: string;
}

/** a credential shape known to belong to another service */
interface RefusedCredential {
  /** matches the refused shape without needing a network call */
  pattern: RegExp;
  /** what such a credential is, such as "an API token of another service" */
  holds: string;
}

/** the provider management credential: where it is read from and what it must grant */
export interface CredentialPrerequisite {
  /** human-readable credential name */
  label: string;
  /** environment variable read from the process or the selected env file */
  environment: string;
  /** entry name in the local credential store */
  store: string;
  /** what the credential must be allowed to do */
  scope: string;
  /** where to obtain a correctly scoped credential */
  obtain: string;
  /** shapes known to be the wrong credential, refused offline */
  refused: readonly RefusedCredential[];
}

/** host requirements a provider declares as data */
export interface ProviderPrerequisites {
  /** command-line tools the provider runs; empty when it only uses an SDK */
  tools: readonly ToolPrerequisite[];
  /** management credential that authenticate binds */
  credential: CredentialPrerequisite;
  /** provider documentation listed under LEARN MORE in the root help */
  documentation: readonly string[];
}

/** one missing or misconfigured prerequisite and how to fix it */
export interface PrerequisiteProblem {
  /** the tool or credential concerned */
  subject: string;
  /** what is wrong */
  problem: string;
  /** how to fix it */
  fix: string;
}

/** what a provider preflight checks, gathered by core without a provider call */
export interface ProviderPreflightParams {
  /** management credential resolved from its declared sources, when found */
  credential?: string;
  /** where the credential was read from, named in any problem about it */
  credentialSource?: string;
  /**
   * locates an executable on this computer
   * @param command executable name
   * @returns the absolute path, or undefined when the tool is absent
   */
  findTool(command: string): Promise<string | undefined>;
  /**
   * runs a tool's version command
   * @param command executable name
   * @param arguments_ arguments that print the version
   * @returns the printed version text, or undefined when it cannot run
   */
  readVersion(
    command: string,
    arguments_: readonly string[],
  ): Promise<string | undefined>;
}
