import { stderr, stdin } from 'node:process';

import { render, renderToString } from 'ink';

import {
  confirmPromptElement,
  inputPromptElement,
  interactionRootElement,
  multiselectPromptElement,
  secretPromptElement,
  selectPromptElement,
  statusElement,
} from '#cli/components/InteractionPresentation';
import { InteractionExit } from '#kernel/navigation';
import { redactResolved } from '#kernel/redaction';

import { createActivityController } from './activity';

import type { ReactElement } from 'react';

import type {
  Interaction,
  ProgressUpdate,
} from '#application/ports/interaction';

import type { ActivityOptions } from './activity';

/** Ink streams used by the interaction boundary */
interface InteractionIO {
  stdin: NodeJS.ReadableStream;
  stderr: NodeJS.WritableStream;
}

/** command-owned cancellation without adapter process handlers */
export interface InteractionCancellationPort {
  signal: AbortSignal;
  cancel: () => void;
  interrupt: () => void;
}

/** terminal behavior attached to the command-owned cancellation port */
interface InteractionSessionSettings
  extends InteractionCancellationPort, ActivityOptions {}

/** interaction with an explicit terminal-lifetime boundary */
export interface InteractionSession extends Interaction {
  dispose(): Promise<void>;
}

interface PromptMethodsParams {
  noColor: boolean;
  output: NodeJS.WritableStream;
  active: () => boolean;
  quiet: boolean;
  publishProgress: (update: ProgressUpdate) => void;
}

interface PromptRequest {
  element: ReactElement;
  reject: (error: InteractionExit) => void;
}

interface PromptQueueState {
  queue: PromptRequest[];
  active?: PromptRequest;
  disposed: boolean;
}

type PresentPrompt = <T>(
  build: (
    submit: (value: T) => void,
    cancel: (back?: boolean) => void,
  ) => ReactElement,
  backLabel?: string,
) => Promise<T>;

/**
 * creates one command-lifetime Ink root and an ordered prompt queue
 * @param noColor whether to suppress status colors
 * @param io terminal streams; defaults to the caller's process streams
 * @param cancellation optional command-owned cancellation port
 * @param cancellation.quiet suppresses routine presentation
 * @param cancellation.stagesOwnProgress ignores legacy phase-less progress
 * @returns workflow interaction callbacks and explicit disposal
 */
export function createInteraction(
  noColor: boolean,
  io: InteractionIO = { stdin, stderr },
  cancellation?: InteractionSessionSettings,
): InteractionSession {
  const port = cancellation ?? createLocalCancellationPort();
  const state: PromptQueueState = { queue: [], disposed: false };

  const instance = renderInteractionRoot(io, port);
  const show = (): void => {
    instance.rerender(
      interactionRootElement(
        state.active?.element,
        port.interrupt,
        activity.current(),
      ),
    );
  };
  const activity = createActivityController({
    output: io.stderr,
    options: cancellation ?? {},
    onChange: show,
    active: () => !state.disposed && !port.signal.aborted,
  });
  const activateNext = (): void => {
    if (state.active || state.disposed || port.signal.aborted) {
      return;
    }
    state.active = state.queue.shift();
    show();
  };
  const rejectPending = (): void => {
    const error = new InteractionExit('cancel');
    activity.clear();
    state.active?.reject(error);
    state.active = undefined;
    for (const request of state.queue.splice(0)) {
      request.reject(error);
    }
    if (!state.disposed) {
      show();
    }
  };
  const unsubscribe = subscribeCancellation(port.signal, rejectPending);
  const present = createPromptPresenter(state, port, { show, activateNext });

  return {
    ...createPromptMethods(present, {
      noColor,
      output: io.stderr,
      active: () => !state.disposed && !port.signal.aborted,
      quiet: cancellation?.quiet === true,
      publishProgress: activity.publish,
    }),
    dispose: createSessionDisposer({
      state,
      unsubscribe,
      rejectPending,
      instance,
    }),
  };
}

/**
 * queues prompts and settles only the currently mounted request
 * @param state command-lifetime prompt state
 * @param port command-owned cancellation authority
 * @param callbacks root rendering and next-prompt activation
 * @param callbacks.show renders the active prompt in the mounted root
 * @param callbacks.activateNext starts the next queued prompt
 * @returns queue-backed prompt presentation
 */
function createPromptPresenter(
  state: PromptQueueState,
  port: InteractionCancellationPort,
  { show, activateNext }: { show: () => void; activateNext: () => void },
): PresentPrompt {
  return async <T>(
    build: (
      submit: (value: T) => void,
      cancel: (back?: boolean) => void,
    ) => ReactElement,
    backLabel?: string,
  ): Promise<T> => {
    if (state.disposed || port.signal.aborted) {
      return Promise.reject(new InteractionExit('cancel'));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const request: PromptRequest = {
        element: build(submit, cancel),
        reject: (error): void => settle(() => reject(error)),
      };
      const settle = (complete: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (state.active === request) {
          state.active = undefined;
          show();
          queueMicrotask(activateNext);
        } else {
          const index = state.queue.indexOf(request);
          if (index >= 0) {
            state.queue.splice(index, 1);
          }
        }
        complete();
      };
      function submit(value: T): void {
        if (state.active === request && !port.signal.aborted) {
          settle(() => resolve(value));
        }
      }
      function cancel(back = false): void {
        if (state.active !== request) {
          return;
        }
        const action = back && backLabel ? 'back' : 'cancel';
        settle(() => reject(new InteractionExit(action)));
        if (action === 'cancel') {
          port.cancel();
        }
      }
      state.queue.push(request);
      activateNext();
    });
  };
}

/**
 * unmounts the one Ink root after pending prompts have been rejected
 * @param params queue state and resources owned by the session
 * @param params.state command-lifetime prompt state
 * @param params.unsubscribe removes the command's abort listener
 * @param params.rejectPending settles prompts before unmounting
 * @param params.instance mounted Ink root
 * @returns idempotent asynchronous disposal
 */
function createSessionDisposer({
  state,
  unsubscribe,
  rejectPending,
  instance,
}: {
  state: PromptQueueState;
  unsubscribe: () => void;
  rejectPending: () => void;
  instance: ReturnType<typeof render>;
}): () => Promise<void> {
  let disposePromise: Promise<void> | undefined;

  return async () => {
    disposePromise ??= (async () => {
      state.disposed = true;
      unsubscribe();
      rejectPending();
      await instance.waitUntilRenderFlush();
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    })();

    return disposePromise;
  };
}

/**
 * provides direct adapter callers an invocation-local abort owner
 * @returns cancellation port without process signal handlers
 */
function createLocalCancellationPort(): InteractionCancellationPort {
  const controller = new AbortController();

  return {
    signal: controller.signal,
    cancel: () => controller.abort(),
    interrupt: () => controller.abort(),
  };
}

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
function createPromptMethods(
  present: PresentPrompt,
  { noColor, output, active, quiet, publishProgress }: PromptMethodsParams,
): Interaction {
  return {
    input: async (prompt) =>
      present(
        (submit, cancel) =>
          inputPromptElement(prompt, noColor, {
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    secret: async (prompt) =>
      present(
        (submit, cancel) =>
          secretPromptElement(prompt, noColor, {
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    select: async (prompt, choices) =>
      present(
        (submit, cancel) =>
          selectPromptElement(prompt, choices, {
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    multiselect: async (prompt, choices) =>
      present(
        (submit, cancel) =>
          multiselectPromptElement(prompt, choices, {
            onSubmit: submit,
            onCancel: cancel,
          }),
        prompt.backLabel,
      ),
    confirm: async (prompt) =>
      present(
        (submit, cancel) => confirmPromptElement(prompt, submit, cancel),
        prompt.backLabel,
      ),
    progress: publishProgress,
    status: (update) => {
      if (active() && !(quiet && ['info', 'success'].includes(update.kind))) {
        writeStatus(statusElement(update, noColor), output);
      }
    },
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

/**
 * binds prompt rejection to the caller signal and observes pre-aborted scopes
 * @param signal invocation cancellation signal
 * @param onAbort rejects pending prompts
 * @returns listener disposal callback
 */
function subscribeCancellation(
  signal: AbortSignal,
  onAbort: () => void,
): () => void {
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }

  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * creates the persistent root with command-owned interruption handling
 * @param io command terminal streams
 * @param port originating cancellation authority
 * @returns mounted Ink instance
 */
function renderInteractionRoot(
  io: InteractionIO,
  port: InteractionCancellationPort,
): ReturnType<typeof render> {
  return render(interactionRootElement(undefined, port.interrupt), {
    stdin: io.stdin,
    stdout: io.stderr,
    stderr: io.stderr,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
}
