import type { AgentId, HarnessId, NetworkId, ProviderId } from '#core/catalog';

/** supported workstation operations */
export type CommandName =
  'create' | 'setup' | 'list' | 'show' | 'terminate' | 'doctor';

/** targetable setup areas */
export type SetupSection =
  | 'all'
  | 'agent'
  | 'network'
  | 'github'
  | 'git'
  | 'proxy'
  | 'env'
  | 'plugins'
  | 'tools';

/** one harness's native plugin and marketplace selections */
export interface HarnessPluginOptions {
  /** enables or disables the harness's plugins */
  isEnabled?: boolean;
  /** marketplace sources to add */
  marketplaces?: string[];
  /** plugins to install */
  plugins?: string[];
  /** marketplace sources to remove (setup only) */
  removeMarketplaces?: string[];
  /** plugins to disable (setup only) */
  disablePlugins?: string[];
  /** plugins to uninstall (setup only) */
  uninstallPlugins?: string[];
}

/** values parsed from CLI flags; secret-bearing fields contain references, never raw credentials */
export interface CommandOptions {
  /** workstation name, from --name */
  name?: string;
  /** explicit env file read before the ambient environment */
  env?: string;
  /** setup section to configure */
  section?: SetupSection;
  /** harness whose plugins the setup plugins section changes */
  pluginHarness?: HarnessId;
  /** selected provider */
  provider?: ProviderId;
  /** selected ACP agent */
  agent?: AgentId;
  /** release channel of the selected ACP agent */
  release?: string;
  /** fewest CPUs the machine must provide, from --cpu */
  cpu?: number;
  /** least memory in whole gigabytes the machine must provide, from --mem */
  mem?: number;
  /** selected harnesses, from the repeatable --harness */
  harness?: HarnessId[];
  /** selected network */
  network?: NetworkId;
  /** minutes without activity before the workstation may sleep; 0 never */
  idleMinutes?: number;
  /** minutes a turn hold lasts after its last refresh */
  holdMaxMinutes?: number;
  /** minutes between scheduled update checks */
  updateCheckMinutes?: number;
  /** days after the last successful update before another is due */
  updateDueDays?: number;
  /** disables every prompt */
  nonInteractive?: boolean;
  /** prints one JSON result instead of human output */
  json?: boolean;
  /** confirms prompts that would otherwise ask for consent */
  yes?: boolean;
  /** enables or disables color regardless of the terminal */
  color?: boolean;
  /** shows detailed status */
  verbose?: boolean;
  /** hides routine status and progress */
  quiet?: boolean;
  /** configures or skips the native GitHub CLI credential */
  github?: boolean;
  /** configures or skips the Git and Jujutsu identity */
  gitIdentity?: boolean;
  /** configures or skips native plugins for every harness */
  plugins?: boolean;
  /** per-harness plugin selections, keyed by harness id */
  harnessPlugins?: Partial<Record<HarnessId, HarnessPluginOptions>>;
  /** reads and saves credentials on this computer when enabled */
  localCredentials?: boolean;
  /** requests a pairing code from an agent that supports pairing */
  withPairCode?: boolean;
  /** adds a live guest inspection to show */
  inspect?: boolean;
  /** installs the latest managed tools in place, without restarting a service */
  update?: boolean;
  /** routes harnesses through CLIProxyAPI when enabled */
  proxy?: boolean;
  /** routes guest traffic through a network exit node when enabled */
  useExitNode?: boolean;
  /** exit node that routes guest traffic */
  exitNode?: string;
  /** account or network the network management credential manages */
  networkAccount?: string;
  /** base URL of the CLIProxyAPI hub */
  proxyUrl?: string;
  /** Git author name */
  gitName?: string;
  /** Git author email */
  gitEmail?: string;
  /** Git committer name, defaulting to the author name */
  gitCommitterName?: string;
  /** Git committer email, defaulting to the author email */
  gitCommitterEmail?: string;
  /** GitHub host the native credential authenticates against */
  githubHost?: string;
  /** source reference of the provider management credential */
  providerTokenSource?: string;
  /** source reference of the network management credential */
  networkKeySource?: string;
  /** source reference of a single-use network enrollment credential */
  networkAuthKeySource?: string;
  /** source reference of the CLIProxyAPI key */
  proxyApiKeySource?: string;
  /** source reference of the GitHub token */
  githubTokenSource?: string;
  /** reuses the marketplace sources of the first harness, in catalog order, that has them for the other harnesses, once */
  reuseMarketplaces?: boolean;
}

/** parsed command and its optional machine selection */
export interface CommandRequest {
  command: CommandName;
  machine?: string;
  options: CommandOptions;
}

/** a non-secret choice presented by the interactive UI */
export interface InteractionChoice<V extends string = string> {
  label: string;
  value: V;
  description?: string;
  disabledReason?: string;
  /** starts selected in a multiple choice */
  isPreselected?: boolean;
}

/** prompt properties shared by textual and secret input */
export interface InteractionPrompt {
  message: string;
  description?: string;
  defaultValue?: string;
  defaultAnswer?: boolean;
  backLabel?: string;
  required?: boolean;
}

/** ordinary text prompt with optional inline value validation */
export interface TextInputPrompt extends InteractionPrompt {
  validate?: (value: string) => string | undefined;
}

/** masked prompt that asks again while the entered value fails validation */
export interface SecretInputPrompt extends Omit<
  InteractionPrompt,
  'defaultValue'
> {
  /**
   * checks the entered value without echoing it
   * @param value entered secret
   * @returns why the value is refused, or undefined to accept it
   */
  validate?: (value: string) => string | undefined;
}

/** progress emitted by an operation; detail must contain no credentials */
export interface ProgressUpdate {
  stage: string;
  message: string;
  completed?: number;
  total?: number;
  phase?: 'start' | 'complete';
  outcome?: 'ok' | 'failed';
  durationMs?: number;
}

/** user-facing status emitted by an operation */
export interface StatusUpdate {
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

/** interaction boundary implemented by the inline CLI UI */
export interface Interaction {
  input(prompt: TextInputPrompt): Promise<string>;
  secret(prompt: SecretInputPrompt): Promise<string>;
  select<V extends string>(
    prompt: InteractionPrompt,
    choices: ReadonlyArray<InteractionChoice<V>>,
  ): Promise<V>;
  multiselect<V extends string>(
    prompt: InteractionPrompt,
    choices: ReadonlyArray<InteractionChoice<V>>,
  ): Promise<V[]>;
  confirm(prompt: InteractionPrompt): Promise<boolean>;
  progress(update: ProgressUpdate): void;
  status(update: StatusUpdate): void;
}

/** structured error returned by the core dispatcher, including incomplete resources */
export type CommandErrorCode =
  | 'USAGE'
  | 'INPUT'
  | 'AUTH'
  | 'PREFLIGHT'
  | 'CONFLICT'
  | 'PROVIDER'
  | 'CANCELLED'
  | 'UNEXPECTED';

/** structured failure and recoverable resource identity */
export interface CommandError {
  code: CommandErrorCode;
  message: string;
  machine?: string;
  machineId?: string;
  setupIncomplete?: boolean;
  details?: string[];
  outcome?: 'retained' | 'absent' | 'unknown';
}
