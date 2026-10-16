import process, { stdin, stderr } from 'node:process';

import { parse } from 'dotenv';

import { commandError, CommandFault, resultExitCode } from '#errors';
import {
  OperationContext,
  checkOperation,
  runOperation,
  traceStage,
  withOperation,
} from '#operation';
import { readInputFile } from '#utilities/input-file';
import { validateCommandRequest } from '#validation';
import { runCommand } from '#workstation';

import { createCommandCancellation } from './cancellation';
import { createInteraction } from './interaction';
import { resolveProcessExecutionOptions } from './mode';
import { prepareResult, writePreparedResult } from './output';
import { createStageReporter, createStatusReporter } from './reporting';
import { flushOutput } from './streams';

import type { CommandResult, CommandSuccess } from '#command';
import type {
  CommandError,
  CommandOptions,
  CommandRequest,
} from '#command/contracts';

import type { CommandCancellation } from './cancellation';
import type { InteractionSession } from './interaction';
import type { PreparedResult } from './output';
import type { ExecutionState } from './parser';

const RENDER_FAILURE_MESSAGE =
  'The command result could not be rendered safely.';

/**
 * owns the ordinary result object and its mode-independent exit status
 * @param result completed command or parser failure
 * @param options selected output mode
 * @param state invocation-local emission ownership
 */
export function emitResult(
  result: CommandResult,
  options: CommandOptions,
  state: ExecutionState,
): void {
  if (state.emitted) {
    return;
  }
  let completed = result;
  let prepared: PreparedResult;
  try {
    prepared = prepareResult(result, options);
  } catch {
    completed = preparationFailure(result);
    try {
      prepared = prepareResult(completed, options);
    } catch {
      completed = {
        command: state.command,
        ok: false,
        error: { code: 'UNEXPECTED', message: RENDER_FAILURE_MESSAGE },
      };
      prepared = options.json
        ? {
            channel: 'stdout',
            text: `${JSON.stringify({ schemaVersion: 1, ...completed })}\n`,
          }
        : { channel: 'stderr', text: `${RENDER_FAILURE_MESSAGE}\n` };
    }
  }
  state.emitted = true;
  process.exitCode = resultExitCode(completed);
  writePreparedResult(prepared);
}

/**
 * retains verified recovery identity when a result cannot be rendered
 * @param result original typed outcome
 * @returns safe D10 failure without the malformed data branch
 */
function preparationFailure(result: CommandResult): CommandResult {
  const recovery = result.ok
    ? successRecovery(result)
    : {
        machine: result.error.machine,
        machineId: result.error.machineId,
        setupIncomplete: result.error.setupIncomplete,
        outcome: result.error.outcome,
        details: result.error.details,
      };

  return {
    command: result.command,
    ok: false,
    error: {
      code: 'UNEXPECTED',
      message: RENDER_FAILURE_MESSAGE,
      ...recovery,
    },
  };
}

/**
 * retains typed workstation identity after a successful result cannot be rendered
 * @param result completed command with malformed presentation data
 * @returns available identity and a truthful retry boundary
 */
function successRecovery(
  result: CommandSuccess,
): Pick<
  CommandError,
  'machine' | 'machineId' | 'setupIncomplete' | 'outcome' | 'details'
> {
  const machine =
    result.command === 'list'
      ? undefined
      : result.command === 'setup'
        ? 'machine' in result.data
          ? result.data.machine
          : undefined
        : result.data.machine;
  if (!machine) {
    return {};
  }

  return {
    machine: machine.name,
    machineId: machine.id,
    setupIncomplete: machine.setup === 'incomplete' ? true : undefined,
    outcome: 'unknown',
    details:
      result.command === 'terminate'
        ? ['Workstation deleted; verify network cleanup before retrying.']
        : [
            `Inspect: open-agent show ${JSON.stringify(machine.name)} --inspect`,
          ],
  };
}

/**
 * routes one parsed command into the shared application workflow
 * @param request typed command request
 * @param state invocation-local result ownership
 */
export async function execute(
  request: CommandRequest,
  state: ExecutionState,
): Promise<void> {
  state.command = request.command;
  let session: InteractionSession | undefined;
  const cancellation = createCommandCancellation({
    onForce: () => {
      operation.close();
      void session?.dispose().catch(() => undefined);
      if (!state.emitted) {
        emitResult(
          forcedCancellation(request, operation),
          request.options,
          state,
        );
      }
    },
  });
  const operation = createExecutionOperation(
    request,
    cancellation,
    () => session,
  );
  try {
    let result: CommandResult;
    try {
      result = await runScopedCommand({
        request,
        operation,
        cancellation,
        setSession: (next) => {
          session = next;
        },
      });
    } catch (error) {
      result = executionFailure(request, operation, error);
    } finally {
      await session?.dispose();
    }
    if (cancellation.signal.aborted && result.ok) {
      result = forcedCancellation(request, operation, false);
    }
    if (!state.emitted) {
      emitResult(result, request.options, state);
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
 * @param params.request parsed command
 * @param params.operation caller-owned operation context
 * @param params.cancellation signal owner
 * @param params.setSession passes the mounted session to its disposal owner
 * @returns the completed command result
 */
async function runScopedCommand({
  request,
  operation,
  cancellation,
  setSession,
}: {
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
          async () => readModeEnvironment(request.options, operation),
          operation,
        ),
      { operation },
    );
    const { options, promptBlocker } = resolveProcessExecutionOptions(
      request.options,
      modeEnv,
    );
    operation.setPromptBlocker(promptBlocker);
    const session = options.nonInteractive
      ? undefined
      : createInteraction(
          options.color === false ||
            (options.color !== true && Boolean(modeEnv.NO_COLOR)),
          { stdin, stderr },
          {
            ...cancellation,
            quiet: options.quiet === true,
            stagesOwnProgress: true,
          },
        );
    setSession(session);
    checkOperation(operation);

    return traceStage(
      'command',
      async () => runCommand({ ...request, options }, session),
      { operation, succeeded: (result) => result.ok },
    );
  });
}

/**
 * rejects supplied syntax and known automation constraints before env-file reads
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
 * @param request parsed command and verbose mode
 * @param cancellation command-owned interruption authority
 * @param session current terminal session, when available
 * @returns invocation context
 */
function createExecutionOperation(
  request: CommandRequest,
  cancellation: CommandCancellation,
  session: () => InteractionSession | undefined,
): OperationContext {
  return new OperationContext({
    signal: cancellation.signal,
    onStage: createStageReporter(request, session),
    onStatus: createStatusReporter(request, session),
  });
}

/**
 * reports forced interruption without asserting that pending mutations stopped
 * @param request original command request
 * @param operation last observed command and resource identity
 * @param forced whether a second physical interrupt forced termination
 * @returns a versioned-output-compatible cancellation outcome
 */
function forcedCancellation(
  request: CommandRequest,
  operation: OperationContext,
  forced = true,
): CommandResult {
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
 * reads the explicitly selected env file before choosing interaction mode
 * @param options command options
 * @param operation captured invocation before the workflow scope
 * @returns merged mode facts with process environment precedence
 */
async function readModeEnvironment(
  options: CommandOptions,
  operation: OperationContext,
): Promise<NodeJS.ProcessEnv> {
  try {
    const selectedEnv = options.envFile
      ? parse(await readInputFile(options.envFile, operation))
      : {};

    return { ...selectedEnv, ...process.env };
  } catch (cause) {
    checkOperation(operation);
    throw new CommandFault({
      code: 'INPUT',
      message: `Selected env file ${JSON.stringify(options.envFile)} must be a readable regular file.`,
      cause,
      causeVisibility: 'private',
    });
  }
}

/**
 * preserves observed identity for failures before a workflow result exists
 * @param request parsed command request
 * @param operation captured invocation context
 * @param error caught boundary failure
 * @returns typed failure with known identity
 */
function executionFailure(
  request: CommandRequest,
  operation: OperationContext,
  error: unknown,
): CommandResult {
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
