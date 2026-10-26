import process, { stdin, stderr } from 'node:process';

import { parse } from 'dotenv';

import { commandError } from '#application/failures';
import { validateCommandRequest } from '#application/validation';
import { runCommand } from '#application/workstation';
import { CommandFault } from '#kernel/faults';
import {
  OperationContext,
  checkOperation,
  runOperation,
  traceStage,
  withOperation,
} from '#kernel/operation';

import { createCommandCancellation } from './cancellation';
import { emitResult } from './emit';
import { createInteraction } from './interaction';
import { resolveProcessExecutionOptions } from './mode';
import { createStageReporter, createStatusReporter } from './reporting';
import { flushOutput } from './streams';

import type { CommandOptions, CommandRequest } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { CommandResult } from '#application/result';

import type { CommandCancellation } from './cancellation';
import type { InteractionSession } from './interaction';
import type { ExecutionState } from './parser';

/** dependencies and parsed request for one command invocation */
export interface ExecuteParams {
  dependencies: ApplicationDependencies;
  request: CommandRequest;
  state: ExecutionState;
}

/** command inputs whose stage and status belong to one operation */
interface CreateExecutionOperationParams {
  request: CommandRequest;
  cancellation: CommandCancellation;
  session: () => InteractionSession | undefined;
}

/** known command identity and interruption strength */
interface ForcedCancellationParams {
  request: CommandRequest;
  operation: OperationContext;
  forced?: boolean;
}

/** selected command options and invocation for environment input */
interface ReadModeEnvironmentParams {
  dependencies: ApplicationDependencies;
  options: CommandOptions;
  operation: OperationContext;
}

/** caught boundary failure and its observed command identity */
interface ExecutionFailureParams {
  request: CommandRequest;
  operation: OperationContext;
  error: unknown;
}

/**
 * routes one parsed command into the shared application workflow
 * @param params dependencies, parsed request and invocation state
 * @param params.dependencies what the workflows run on
 * @param params.request typed command request
 * @param params.state invocation-local result ownership
 */
export async function execute({
  dependencies,
  request,
  state,
}: ExecuteParams): Promise<void> {
  state.command = request.command;
  let session: InteractionSession | undefined;
  const cancellation = createCommandCancellation({
    onForce: () => {
      operation.close();
      void session?.dispose().catch(() => undefined);
      if (!state.emitted) {
        state.emitted = true;
        emitResult(forcedCancellation({ request, operation }), request.options);
      }
    },
  });
  const operation = createExecutionOperation({
    request,
    cancellation,
    session: () => session,
  });
  try {
    let result: CommandResult;
    try {
      result = await runScopedCommand({
        dependencies,
        request,
        operation,
        cancellation,
        setSession: (next) => {
          session = next;
        },
      });
    } catch (error) {
      result = executionFailure({ request, operation, error });
    } finally {
      await session?.dispose();
    }
    if (cancellation.signal.aborted && result.ok) {
      result = forcedCancellation({ request, operation, forced: false });
    }
    if (!state.emitted) {
      state.emitted = true;
      emitResult(result, request.options);
    }
    await flushOutput();
  } finally {
    operation.close();
    cancellation.dispose();
  }
}

/**
 * runs validation, mode selection and the real workflow in one invocation scope
 * @param params command, cancellation and session ownership
 * @param params.dependencies what the workflows run on
 * @param params.request parsed command
 * @param params.operation caller-owned operation context
 * @param params.cancellation signal owner
 * @param params.setSession passes the mounted session to its disposal owner
 * @returns the completed command result
 */
async function runScopedCommand({
  dependencies,
  request,
  operation,
  cancellation,
  setSession,
}: {
  dependencies: ApplicationDependencies;
  request: CommandRequest;
  operation: OperationContext;
  cancellation: CommandCancellation;
  setSession: (session: InteractionSession | undefined) => void;
}): Promise<CommandResult> {
  return withOperation(operation, async () => {
    validateEarlyRequest(request, operation);
    const modeEnv = await traceStage(
      'environment',
      async () =>
        runOperation(
          async () =>
            readModeEnvironment({
              dependencies,
              options: request.options,
              operation,
            }),
          operation,
        ),
      { operation },
    );
    const mode = resolveProcessExecutionOptions(request.options, modeEnv);
    operation.setPromptBlocker(mode.promptBlocker);
    const { options } = mode;
    const session = options.nonInteractive
      ? undefined
      : createInteraction({
          noColor:
            options.color === false ||
            (options.color !== true && Boolean(modeEnv.NO_COLOR)),
          io: { stdin, stderr },
          cancellation: {
            ...cancellation,
            quiet: options.quiet === true,
            stagesOwnProgress: true,
          },
        });
    setSession(session);
    checkOperation(operation);

    return traceStage(
      'command',
      async () =>
        runCommand(
          dependencies,
          { ...request, options },
          { interaction: session },
        ),
      { operation, succeeded: (result) => result.ok },
    );
  });
}

/**
 * rejects supplied syntax and known automation constraints before credential-file reads
 * @param request parsed command before selected dotenv mode values are available
 * @param operation invocation that records the actual prompt blocker
 */
function validateEarlyRequest(
  request: CommandRequest,
  operation: OperationContext,
): void {
  const resolution = resolveProcessExecutionOptions(
    request.options,
    process.env,
  );
  operation.setPromptBlocker(resolution.promptBlocker);
  validateCommandRequest({
    ...request,
    options: resolution.options,
  });
}

/**
 * binds verbose diagnostics to the current cancellation scope
 * @param params command, cancellation authority and current session
 * @param params.request parsed command and verbose mode
 * @param params.cancellation command-owned interruption authority
 * @param params.session current terminal session, when available
 * @returns invocation context
 */
function createExecutionOperation({
  request,
  cancellation,
  session,
}: CreateExecutionOperationParams): OperationContext {
  return new OperationContext({
    signal: cancellation.signal,
    onStage: createStageReporter(request, session),
    onStatus: createStatusReporter(request, session),
  });
}

/**
 * reports forced interruption without asserting that pending mutations stopped
 * @param params original request, observed identity and interruption strength
 * @param params.request original command request
 * @param params.operation last observed command and resource identity
 * @param params.forced whether a second physical interrupt forced termination
 * @returns a versioned-output-compatible cancellation outcome
 */
function forcedCancellation({
  request,
  operation,
  forced = true,
}: ForcedCancellationParams): CommandResult {
  const name = operation.target?.name ?? request.machine;

  return {
    command: operation.command ?? request.command,
    ok: false,
    error: {
      code: 'CANCELLED',
      message: forced
        ? 'Forced interruption; remote work and recovery may be unfinished.'
        : 'Cancelled by user; inspect any retained workstation before retrying.',
      machine: name,
      machineId: operation.target?.id,
      outcome: name ? 'unknown' : undefined,
      details: name
        ? [
            'Inspect provider state before retrying any mutation.',
            `Inspect: open-agent show ${JSON.stringify(name)} --inspect`,
          ]
        : undefined,
    },
  };
}

/**
 * reads the explicitly selected credential file before choosing interaction mode
 * @param params dependencies, selected options and invocation context
 * @param params.dependencies what the workflows run on
 * @param params.options command options
 * @param params.operation captured invocation before the workflow scope
 * @returns merged mode facts, the selected credential file taking precedence
 */
async function readModeEnvironment({
  dependencies,
  options,
  operation,
}: ReadModeEnvironmentParams): Promise<NodeJS.ProcessEnv> {
  try {
    const selectedEnv = options.credentialFile
      ? parse(
          await dependencies.host.readInputFile(
            options.credentialFile,
            operation,
          ),
        )
      : {};

    return { ...process.env, ...selectedEnv };
  } catch (cause) {
    checkOperation(operation);
    throw new CommandFault({
      code: 'INPUT',
      message: `Selected credential file ${JSON.stringify(options.credentialFile)} must be a readable regular file.`,
      cause,
      causeVisibility: 'private',
    });
  }
}

/**
 * preserves observed identity for failures before a workflow result exists
 * @param params parsed request, invocation context and caught failure
 * @param params.request parsed command request
 * @param params.operation captured invocation context
 * @param params.error caught boundary failure
 * @returns typed failure with known identity
 */
function executionFailure({
  request,
  operation,
  error,
}: ExecutionFailureParams): CommandResult {
  return {
    command: operation.command ?? request.command,
    ok: false,
    error: {
      ...commandError(error),
      machine: operation.target?.name ?? request.machine,
      machineId: operation.target?.id,
    },
  };
}
