import { ConfirmInput, Select } from './Choices';
import { StatusMessage, TaskProgress } from './Display';
import { InteractionRoot } from './InteractionRoot';
import { MultiSelect } from './MultiSelect';
import { SecretInput, TextInput } from './TextInput';

import type { ReactElement } from 'react';

import type {
  InteractionChoice,
  InteractionPrompt,
  SecretInputPrompt,
  ProgressUpdate,
  TextInputPrompt,
} from '#application/ports/interaction';
import type { StatusUpdate } from '#kernel/status';

/** persistent prompt and progress presented in one terminal root */
interface InteractionRootElementParams {
  prompt: ReactElement | undefined;
  onInterrupt: () => void;
  activity?: ProgressUpdate & { startedAt: number };
}

/** text prompt and callbacks to render */
interface InputPromptElementParams extends PromptCallbacks<string> {
  prompt: TextInputPrompt;
  noColor: boolean;
}

/** secret prompt and callbacks to render */
interface SecretPromptElementParams extends PromptCallbacks<string> {
  prompt: SecretInputPrompt;
  noColor: boolean;
}

/** single-choice prompt and callbacks to render */
interface SelectPromptElementParams<
  V extends string,
> extends PromptCallbacks<V> {
  prompt: InteractionPrompt;
  choices: ReadonlyArray<InteractionChoice<V>>;
}

/** multiple-choice prompt and callbacks to render */
interface MultiSelectPromptElementParams<
  V extends string,
> extends PromptCallbacks<V[]> {
  prompt: InteractionPrompt;
  choices: ReadonlyArray<InteractionChoice<V>>;
}

/** confirmation prompt and callbacks to render */
interface ConfirmPromptElementParams extends PromptCallbacks<boolean> {
  prompt: InteractionPrompt;
}

type PromptCallbacks<T> = {
  onSubmit: (value: T) => void;
  onCancel: (back?: boolean) => void;
};

/**
 * creates the element for the persistent input owner
 * @param params active prompt, interrupt callback and progress
 * @param params.prompt prompt to present
 * @param params.onInterrupt interrupt handler
 * @param params.activity current activity state
 * @returns the root element for Ink rendering
 */
export function interactionRootElement({
  prompt,
  onInterrupt,
  activity,
}: InteractionRootElementParams): ReactElement {
  return (
    <InteractionRoot
      activity={activity && progressElement(activity, activity.startedAt)}
      prompt={prompt}
      onInterrupt={onInterrupt}
    />
  );
}

/**
 * creates an ordinary text prompt with inline validation
 * @param params ordinary text prompt and callbacks
 * @param params.prompt prompt to present
 * @param params.noColor whether color is disabled
 * @param params.onSubmit value submission handler
 * @param params.onCancel rejects or returns to a parent prompt
 * @returns the text prompt element
 */
export function inputPromptElement({
  prompt,
  noColor,
  onSubmit,
  onCancel,
}: InputPromptElementParams): ReactElement {
  return (
    <TextInput
      backLabel={prompt.backLabel}
      defaultValue={prompt.defaultValue}
      description={prompt.description}
      label={prompt.message}
      noColor={noColor}
      required={prompt.required}
      validate={prompt.validate}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

/**
 * creates a masked secret prompt
 * @param params secret prompt and callbacks
 * @param params.prompt prompt to present
 * @param params.noColor whether color is disabled
 * @param params.onSubmit value submission handler
 * @param params.onCancel rejects or returns to a parent prompt
 * @returns masked entry without prefilled plaintext
 */
export function secretPromptElement({
  prompt,
  noColor,
  onSubmit,
  onCancel,
}: SecretPromptElementParams): ReactElement {
  return (
    <SecretInput
      backLabel={prompt.backLabel}
      description={prompt.description}
      label={prompt.message}
      noColor={noColor}
      required={prompt.required}
      validate={prompt.validate}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

/**
 * creates a single-choice prompt
 * @param params single-choice prompt, choices and callbacks
 * @param params.prompt prompt to present
 * @param params.choices choices offered by the prompt
 * @param params.onSubmit value submission handler
 * @param params.onCancel rejects or returns to a parent prompt
 * @returns the single-choice prompt element
 */
export function selectPromptElement<V extends string>({
  prompt,
  choices,
  onSubmit,
  onCancel,
}: SelectPromptElementParams<V>): ReactElement {
  return (
    <Select
      backLabel={prompt.backLabel}
      choices={choices}
      description={prompt.description}
      label={prompt.message}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

/**
 * creates a multiple-choice prompt
 * @param params multiple-choice prompt, choices and callbacks
 * @param params.prompt prompt to present
 * @param params.choices choices offered by the prompt
 * @param params.onSubmit value submission handler
 * @param params.onCancel rejects or returns to a parent prompt
 * @returns the multiple-choice prompt element
 */
export function multiselectPromptElement<V extends string>({
  prompt,
  choices,
  onSubmit,
  onCancel,
}: MultiSelectPromptElementParams<V>): ReactElement {
  return (
    <MultiSelect
      backLabel={prompt.backLabel}
      choices={choices}
      description={prompt.description}
      label={prompt.message}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

/**
 * creates a yes/no prompt
 * @param params confirmation prompt and callbacks
 * @param params.prompt prompt to present
 * @param params.onSubmit value submission handler
 * @param params.onCancel rejects or returns to a parent prompt
 * @returns the confirmation prompt element
 */
export function confirmPromptElement({
  prompt,
  onSubmit,
  onCancel,
}: ConfirmPromptElementParams): ReactElement {
  return (
    <ConfirmInput
      backLabel={prompt.backLabel}
      defaultAnswer={prompt.defaultAnswer}
      description={prompt.description}
      label={prompt.message}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

/**
 * creates a progress line
 * @param update current progress report
 * @param startedAt stage start time when live in the persistent root
 * @returns Ink node with stage and optional completion counts
 */
export function progressElement(
  update: ProgressUpdate,
  startedAt?: number,
): ReactElement {
  return <TaskProgress startedAt={startedAt} update={update} />;
}

/**
 * creates a status line
 * @param update current status report
 * @param noColor whether color is disabled
 * @returns Ink node with status kind and optional color
 */
export function statusElement(
  update: StatusUpdate,
  noColor: boolean,
): ReactElement {
  return <StatusMessage noColor={noColor} update={update} />;
}
