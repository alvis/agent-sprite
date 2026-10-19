import type { StatusUpdate } from '#kernel/status';

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
