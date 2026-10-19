import { AsyncLocalStorage } from 'node:async_hooks';

import { InteractionExit } from '#kernel/navigation';

import type { CommandName } from '#kernel/commands';
import type { StatusSink, StatusUpdate } from '#kernel/status';

/** exact provider identity observed during one invocation */
interface OperationTarget {
  name: string;
  id?: string;
}

/** caller cancellation authority for one host invocation */
interface OperationParams {
  signal: AbortSignal;
  onStage?: (event: StageEvent) => void;
  onStatus?: (update: StatusUpdate) => void;
}

/** bounded diagnostic facts for a real workflow stage */
export interface StageEvent {
  stage: string;
  event: 'start' | 'complete';
  durationMs?: number;
  outcome?: 'ok' | 'failed';
  command?: CommandName;
  targetKnown: boolean;
}

const operationScope = new AsyncLocalStorage<OperationContext>();
const RECOVERY_TIMEOUT_MS = 30_000;
const IO_TIMEOUT_MS = 30_000;

/** invocation-local cancellation, lifetime and verified resource identity */
export class OperationContext {
  public readonly signal: AbortSignal;
  #lifetime = new AbortController();
  #target: OperationTarget | undefined;
  #command: CommandName | undefined;
  readonly #onStage: ((event: StageEvent) => void) | undefined;
  readonly #onStatus: ((update: StatusUpdate) => void) | undefined;
  #promptBlocker: string | undefined;

  /**
   * binds one workflow to its caller and local lifetime
   * @param params caller cancellation signal
   * @param params.signal caller cancellation signal
   * @param params.onStage optional stage diagnostic observer
   * @param params.onStatus optional non-secret status observer
   */
  constructor({ signal, onStage, onStatus }: OperationParams) {
    this.signal = AbortSignal.any([signal, this.#lifetime.signal]);
    this.#onStage = onStage;
    this.#onStatus = onStatus;
  }

  /**
   * returns the command currently executing
   * @returns selected command, if any
   */
  public get command(): CommandName | undefined {
    return this.#command;
  }

  /**
   * returns the last observed resource for truthful cancellation reporting
   * @returns observed identity, if any
   */
  public get target(): OperationTarget | undefined {
    return this.#target;
  }

  /**
   * reports whether this invocation has relinquished its lifetime
   * @returns whether descendants must stop all further work
   */
  public get closed(): boolean {
    return this.#lifetime.signal.aborted;
  }

  /** non-secret reason a needed prompt was unavailable in this invocation */
  public get promptBlocker(): string | undefined {
    return this.#promptBlocker;
  }

  /**
   * records the actual implicit terminal condition after mode resolution
   * @param reason non-secret terminal reason, if one blocked prompts
   */
  public setPromptBlocker(reason: string | undefined): void {
    this.#promptBlocker = reason;
  }

  /**
   * records provider identity even when cancellation arrived during creation
   * @param target exact provider identity
   */
  public identify(target: OperationTarget): void {
    if (this.closed) {
      throw cancellationReason();
    }
    this.#target = target;
  }

  /**
   * identifies a menu-selected command before its side effects
   * @param command actual selected command
   */
  public select(command: CommandName): void {
    checkOperation(this);
    this.#command = command;
  }

  /** prevents descendants from starting effects after the owner finishes */
  public close(): void {
    this.#lifetime.abort(cancellationReason());
  }

  /**
   * emits one whitelisted stage event without exposing inputs
   * @param event current stage and duration
   */
  public reportStage(event: Omit<StageEvent, 'command' | 'targetKnown'>): void {
    if (this.closed) {
      return;
    }
    this.#onStage?.({
      ...event,
      command: this.#command,
      targetKnown: this.#target !== undefined,
    });
  }

  /**
   * publishes a non-secret status through this invocation's reporter
   * @param update status from a selected workflow
   * @returns whether the invocation reporter accepted the status
   */
  public reportStatus(update: StatusUpdate): boolean {
    if (this.closed || !this.#onStatus) {
      return false;
    }
    this.#onStatus(update);

    return true;
  }
}

/**
 * sends status to the invocation reporter or a direct caller's interaction
 * @param update non-secret status to publish
 * @param interaction optional direct SDK interaction
 */
export function publishStatus(
  update: StatusUpdate,
  interaction?: StatusSink,
): void {
  const operation = currentOperation();
  if (operation?.closed) {
    return;
  }
  if (!operation?.reportStatus(update)) {
    interaction?.status(update);
  }
}

/**
 * explains why a required prompt could not open for this invocation
 * @returns actionable non-secret detail only for implicit terminal limitations
 */
export function promptUnavailableDetail(): string | undefined {
  const blocker = currentOperation()?.promptBlocker;

  return blocker
    ? `Prompts are disabled because ${blocker}; pass required flags or run in a TTY.`
    : undefined;
}

/**
 * times an actual workflow action within its originating invocation
 * @param stage whitelisted workflow stage name
 * @param action real workflow action
 * @param context originating invocation or stage settings
 * @param context.operation explicit originating invocation
 * @param context.succeeded optional result success check
 * @returns completed action value
 */
export async function traceStage<T>(
  stage: string,
  action: () => Promise<T>,
  context:
    | OperationContext
    | {
        operation?: OperationContext;
        succeeded?: (result: T) => boolean;
      } = {},
): Promise<T> {
  const operation =
    context instanceof OperationContext
      ? context
      : (context.operation ?? currentOperation());
  const succeeded =
    context instanceof OperationContext ? undefined : context.succeeded;
  checkOperation(operation);
  const started = performance.now();
  operation?.reportStage({ stage, event: 'start' });
  try {
    const result = await action();
    operation?.reportStage({
      stage,
      event: 'complete',
      durationMs: Math.round(performance.now() - started),
      outcome: succeeded && !succeeded(result) ? 'failed' : 'ok',
    });

    return result;
  } catch (error) {
    operation?.reportStage({
      stage,
      event: 'complete',
      durationMs: Math.round(performance.now() - started),
      outcome: 'failed',
    });

    throw error;
  }
}

/**
 * runs one explicit host scope and closes its descendants on settlement
 * @param operation independently owned invocation or recovery context
 * @param action workflow executed within the scope
 * @returns workflow outcome with the parent scope restored
 */
export async function withOperation<T>(
  operation: OperationContext,
  action: () => Promise<T>,
): Promise<T> {
  try {
    checkOperation(operation);

    return await operationScope.run(operation, action);
  } finally {
    operation.close();
  }
}

/**
 * accesses only the current asynchronous invocation
 * @returns active or closed originating context, never another invocation
 */
export function currentOperation(): OperationContext | undefined {
  return operationScope.getStore();
}

/**
 * prevents new work after cancellation or owner disposal
 * @param operation captured context, defaulting to the current scope
 */
export function checkOperation(operation = currentOperation()): void {
  if (operation?.signal.aborted) {
    throw operation.signal.reason instanceof DOMException &&
      operation.signal.reason.name === 'TimeoutError'
      ? operation.signal.reason
      : cancellationReason();
  }
}

/**
 * bounds local waiting; unsupported remote effects may continue after rejection
 * @param action actual IO started only after checking the originating scope
 * @param operation captured context, defaulting to the current scope
 * @returns completed IO value after a second cancellation check
 */
export async function runOperation<T>(
  action: () => Promise<T>,
  operation = currentOperation(),
): Promise<T> {
  checkOperation(operation);
  const signal = operation?.signal;
  let onAbort: (() => void) | undefined;
  try {
    const pending = action();
    const result = signal
      ? await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            onAbort = (): void => reject(cancellationReason());
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
            }
          }),
        ])
      : await pending;
    checkOperation(operation);

    return result;
  } catch (error) {
    checkOperation(operation);
    throw error;
  } finally {
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * composes the current caller with the existing transport timeout
 * @param timeoutMs maximum transport duration in milliseconds
 * @returns transport signal respecting both existing bounds and cancellation
 */
export function operationSignal(timeoutMs: number): AbortSignal {
  const operation = currentOperation();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  return operation
    ? AbortSignal.any([operation.signal, timeoutSignal])
    : timeoutSignal;
}

/**
 * bounds independent recovery without reusing an aborted operation signal
 * @param action recovery that returns its observations to the owner
 * @returns bounded recovery outcome with the parent scope restored
 */
export async function recoverOperation<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (currentOperation()?.closed) {
    throw cancellationReason();
  }
  const operation = new OperationContext({
    signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
  });

  return withOperation(operation, async () => runOperation(action, operation));
}

/**
 * creates the typed reason shared by terminal and process cancellation
 * @returns explicit command cancellation
 */
export function cancellationReason(): InteractionExit {
  return new InteractionExit('cancel');
}

/**
 * bounds unsupported IO without shortening existing exec or aggregate deadlines
 * @param action actual IO, optionally consuming its composed deadline signal
 * @param operation originating invocation, if present
 * @returns IO result or a timeout distinct from user cancellation
 */
export async function runBoundedIO<T>(
  action: (signal?: AbortSignal) => Promise<T>,
  operation = currentOperation(),
): Promise<T> {
  if (!operation) {
    return action();
  }
  const deadline = new AbortController();
  const signal = AbortSignal.any([operation.signal, deadline.signal]);
  const timer = setTimeout(() => {
    deadline.abort(
      new DOMException(
        'IO timed out; pending remote work may be unfinished.',
        'TimeoutError',
      ),
    );
  }, IO_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  try {
    return await runOperation(
      async () =>
        Promise.race([
          action(signal),
          new Promise<never>((_resolve, reject) => {
            onAbort = (): void =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : cancellationReason(),
              );
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
            }
          }),
        ]),
      operation,
    );
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
