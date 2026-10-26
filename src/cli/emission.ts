import process from 'node:process';

import { resultExitCode } from '#cli/exit';

import { prepareResult, writePreparedResult } from './output';

import type { CommandOptions } from '#application/contracts';
import type { CommandError } from '#application/failures';
import type { CommandResult, CommandSuccess } from '#application/result';

import type { PreparedResult } from './output';
import type { ExecutionState } from './parser';

/** result and invocation state for one terminal emission */
export interface EmitResultParams {
  result: CommandResult;
  options: CommandOptions;
  state: ExecutionState;
}

const RENDER_FAILURE_MESSAGE =
  'The command result could not be rendered safely.';

/**
 * owns the ordinary result object and its mode-independent exit status
 * @param params completed result, output mode and invocation ownership
 * @param params.result completed command or parser failure
 * @param params.options selected output mode
 * @param params.state invocation-local emission ownership
 */
export function emitResult({ result, options, state }: EmitResultParams): void {
  if (state.emitted) {
    return;
  }
  let completed = result;
  let prepared: PreparedResult;
  try {
    prepared = prepareResult({ result, options });
  } catch {
    completed = preparationFailure(result);
    prepared = prepareResult({ result: completed, options });
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
