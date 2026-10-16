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
  StatusUpdate,
  TextInputPrompt,
} from '#command/contracts';

type PromptCallbacks<T> = {
  onSubmit: (value: T) => void;
  onCancel: (back?: boolean) => void;
};

/**
 * creates the element for the persistent input owner
 * @param prompt currently active prompt, if any
 * @param onInterrupt command-owned interrupt callback
 * @param activity currently active workflow stage and its start time
 * @returns the root element for Ink rendering
 */
export function interactionRootElement(
  prompt: ReactElement | undefined,
  onInterrupt: () => void,
  activity?: ProgressUpdate & { startedAt: number },
): ReactElement {
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
 * @param prompt ordinary text prompt settings
 * @param noColor whether color is disabled
 * @param handlers accepted-value and cancellation callbacks
 * @param handlers.onSubmit accepts the validated text
 * @param handlers.onCancel rejects or returns to a parent prompt
 * @returns the text prompt element
 */
export function inputPromptElement(
  prompt: TextInputPrompt,
  noColor: boolean,
  { onSubmit, onCancel }: PromptCallbacks<string>,
): ReactElement {
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
 * @param prompt secret prompt settings
 * @param noColor whether color is disabled
 * @param handlers accepted-value and cancellation callbacks
 * @param handlers.onSubmit accepts the secret without displaying it
 * @param handlers.onCancel rejects or returns to a parent prompt
 * @returns masked entry without prefilled plaintext
 */
export function secretPromptElement(
  prompt: SecretInputPrompt,
  noColor: boolean,
  { onSubmit, onCancel }: PromptCallbacks<string>,
): ReactElement {
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
 * @param prompt choice prompt settings
 * @param choices available choices
 * @param handlers accepted-value and cancellation callbacks
 * @param handlers.onSubmit accepts the selected value
 * @param handlers.onCancel rejects or returns to a parent prompt
 * @returns the single-choice prompt element
 */
export function selectPromptElement<V extends string>(
  prompt: InteractionPrompt,
  choices: ReadonlyArray<InteractionChoice<V>>,
  { onSubmit, onCancel }: PromptCallbacks<V>,
): ReactElement {
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
 * @param prompt choice prompt settings
 * @param choices available choices
 * @param handlers accepted-values and cancellation callbacks
 * @param handlers.onSubmit accepts the selected values
 * @param handlers.onCancel rejects or returns to a parent prompt
 * @returns the multiple-choice prompt element
 */
export function multiselectPromptElement<V extends string>(
  prompt: InteractionPrompt,
  choices: ReadonlyArray<InteractionChoice<V>>,
  { onSubmit, onCancel }: PromptCallbacks<V[]>,
): ReactElement {
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
 * @param prompt confirmation prompt settings
 * @param onSubmit accepted-answer callback
 * @param onCancel cancellation callback
 * @returns the confirmation prompt element
 */
export function confirmPromptElement(
  prompt: InteractionPrompt,
  onSubmit: (value: boolean) => void,
  onCancel: (back?: boolean) => void,
): ReactElement {
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
