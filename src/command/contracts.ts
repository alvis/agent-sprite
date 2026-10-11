/** supported workstation operations */
export type CommandName =
  'create' | 'setup' | 'list' | 'show' | 'terminate' | 'doctor';

/** targetable setup areas */
export type SetupSection =
  | 'all'
  | 't3'
  | 'tailscale'
  | 'github'
  | 'git'
  | 'proxy'
  | 'env'
  | 'plugins'
  | 'tools';

/** native coding harness identity */
export type HarnessName = 'claude' | 'codex';

/** values parsed from CLI flags. Secret-bearing fields contain references, never raw credentials */
export interface CommandOptions {
  name?: string;
  env?: string;
  section?: SetupSection;
  harness?: HarnessName;
  nonInteractive?: boolean;
  json?: boolean;
  yes?: boolean;
  color?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  github?: boolean;
  gitIdentity?: boolean;
  plugins?: boolean;
  claudePlugins?: boolean;
  codexPlugins?: boolean;
  localCredentials?: boolean;
  withT3PairCode?: boolean;
  inspect?: boolean;
  update?: boolean;
  tailscale?: boolean;
  proxy?: boolean;
  useExitNode?: boolean;
  exitNode?: string;
  tailnet?: string;
  proxyUrl?: string;
  gitName?: string;
  gitEmail?: string;
  gitCommitterName?: string;
  gitCommitterEmail?: string;
  githubHost?: string;
  spritesTokenSource?: string;
  tailscaleApiKeySource?: string;
  tailscaleAuthKeySource?: string;
  proxyApiKeySource?: string;
  githubTokenSource?: string;
  claudeMarketplace?: string[];
  codexMarketplace?: string[];
  claudePlugin?: string[];
  codexPlugin?: string[];
  removeClaudeMarketplace?: string[];
  removeCodexMarketplace?: string[];
  disableClaudePlugin?: string[];
  disableCodexPlugin?: string[];
  uninstallClaudePlugin?: string[];
  uninstallCodexPlugin?: string[];
  reuseClaudeMarketplaces?: boolean;
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
  secret(prompt: InteractionPrompt): Promise<string>;
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
