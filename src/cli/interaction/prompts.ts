import { renderToString } from 'ink';

import {
  confirmPromptElement,
  inputPromptElement,
  multiselectPromptElement,
  secretPromptElement,
  selectPromptElement,
  statusElement,
} from '#cli/components/InteractionPresentation';
import { redactResolved } from '#kernel/redaction';

import type { ReactElement } from 'react';

import type {
  Interaction,
  ProgressUpdate,
} from '#application/ports/interaction';

/** terminal controls used by the interaction's prompt methods */
export interface PromptMethodsParams {
  noColor: boolean;
  output: NodeJS.WritableStream;
  active: () => boolean;
  quiet: boolean;
  publishProgress: (update: ProgressUpdate) => void;
}

/** queues one mounted prompt and resolves its submitted value */
export type PresentPrompt = <T>(
  build: (
    submit: (value: T) => void,
    cancel: (back?: boolean) => void,
  ) => ReactElement,
  backLabel?: string,
) => Promise<T>;

/**
 * binds typed workflow prompts to the one active session
 * @param present queue-backed prompt presentation
 * @param params status rendering and active-session ownership
 * @param params.noColor whether to suppress status colors
 * @param params.output status output stream
 * @param params.active whether the session can publish progress
 * @param params.quiet whether routine status is suppressed
 * @param params.publishProgress command-lifetime activity reporter
 * @returns Interaction callbacks
 */
export function createPromptMethods(
  present: PresentPrompt,
  { noColor, output, active, quiet, publishProgress }: PromptMethodsParams,
): Interaction {
  return {
    ...textPromptMethods(present, noColor),
    ...choicePromptMethods(present),
    progress: publishProgress,
    status: (update) => {
      if (active() && !(quiet && ['info', 'success'].includes(update.kind))) {
        writeStatus(statusElement(update, noColor), output);
      }
    },
  };
}

/**
 * binds visible and secret text entry to the current prompt queue
 * @param present queue-backed prompt presentation
 * @param noColor whether status color is disabled
 * @returns text and secret prompt callbacks
 */
function textPromptMethods(
  present: PresentPrompt,
  noColor: boolean,
): Pick<Interaction, 'input' | 'secret'> {
  return {
    input: async (prompt) =>
      present(
        (submit, cancel) =>
          inputPromptElement({
            prompt,
            noColor,
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    secret: async (prompt) =>
      present(
        (submit, cancel) =>
          secretPromptElement({
            prompt,
            noColor,
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
  };
}

/**
 * binds single, multiple and confirmation choices to the current prompt queue
 * @param present queue-backed prompt presentation
 * @returns choice prompt callbacks
 */
function choicePromptMethods(
  present: PresentPrompt,
): Pick<Interaction, 'select' | 'multiselect' | 'confirm'> {
  return {
    select: async (prompt, choices) =>
      present(
        (submit, cancel) =>
          selectPromptElement({
            prompt,
            choices,
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    multiselect: async (prompt, choices) =>
      present(
        (submit, cancel) =>
          multiselectPromptElement({
            prompt,
            choices,
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    confirm: async (prompt) =>
      present(
        (submit, cancel) =>
          confirmPromptElement({
            prompt,
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
  };
}

/**
 * prints a completed, non-secret status line to stderr
 * @param element completed status element
 * @param output destination for status output
 */
function writeStatus(
  element: ReactElement,
  output: NodeJS.WritableStream,
): void {
  output.write(`${redactResolved(renderToString(element))}\n`);
}
