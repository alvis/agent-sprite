import type {
  CredentialSaveOptions,
  CredentialSaveResult,
  CredentialStoreLocation,
  ManagementCredentialName,
} from '#domain/credentials';
import type { HarnessId } from '#domain/ids';
import type { OperationContext } from '#kernel/operation';

/** local executable invocation with a bounded timeout */
export interface LocalProcessParams {
  program: string;
  arguments: string[];
  timeoutMs?: number;
  trimOutput?: boolean;
}

/** local executable invocation receiving private standard input */
export interface LocalInputParams extends Omit<
  LocalProcessParams,
  'timeoutMs'
> {
  input: string;
  verifyResultExternally?: boolean;
}

/** supported recognition outcomes before changing native marketplace state */
export type MarketplaceCompatibility =
  'supported' | 'unsupported' | 'inaccessible' | 'unknown';

/** bounded source compatibility evidence for one native harness */
export interface MarketplaceClassification {
  source: string;
  harness: HarnessId;
  compatibility: MarketplaceCompatibility;
  manifestPath?: string;
  marketplaceName?: string;
  pluginNames?: string[];
  reason: string;
}

/** what a marketplace lookup needs to know about one native harness */
export interface MarketplaceLookup {
  /** marketplace source reference */
  source: string;
  /** native coding harness whose manifests are looked for */
  harness: HarnessId;
  /** manifest paths the harness documents, in lookup order */
  manifests: readonly string[];
  /** optional GitHub credential for private sources */
  accessToken?: string;
}

/** what the application asks of this computer: processes, files, credentials and the network */
export interface HostPorts {
  /** runs a noninteractive program with bounded execution time and returns its standard output */
  run(params: LocalProcessParams): Promise<string>;
  /** sends private input to a program without shell interpolation */
  sendInput(params: LocalInputParams): Promise<void>;
  /** reads a regular input file without blocking on a pipe or device */
  readInputFile(path: string, operation?: OperationContext): Promise<string>;
  clipboard: {
    /** copies one URL through the platform clipboard tool */
    copyUrl(url: string): Promise<void>;
  };
  credentials: {
    /** returns an explicitly retained management secret, or undefined when none was stored */
    read(
      name: ManagementCredentialName,
      location?: CredentialStoreLocation,
    ): Promise<string | undefined>;
    /** retains a local secret after explicit consent */
    save(
      name: ManagementCredentialName,
      value: string,
      options: CredentialSaveOptions,
    ): Promise<CredentialSaveResult>;
  };
  marketplaces: {
    /** inspects documented marketplace manifests without registering a source */
    classify(lookup: MarketplaceLookup): Promise<MarketplaceClassification>;
  };
  tools: {
    /** locates an executable on PATH without running it */
    findTool(name: string): Promise<string | undefined>;
  };
  environment: {
    /** the variables this computer's process was started with */
    variables(): NodeJS.ProcessEnv;
    /** the home directory of the user running the process */
    homeDirectory(): string;
  };
}
