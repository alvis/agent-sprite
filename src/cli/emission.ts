import process from 'node:process';

import { resultExitCode } from '#cli/exit';

import { prepareResult, writePreparedResult } from './output';

import type { CommandOptions } from '#application/contracts';
import type { CommandError } from '#application/failures';
import type { CommandResult, CommandSuccess } from '#application/result';

import type { PreparedResult } from './output';

const RENDER_FAILURE_MESSAGE =
  'The command result could not be rendered safely.';

/**
 * owns the ordinary result object and its mode-independent exit status
 * @param result completed command or parser failure
 * @param options selected output mode
 */
export function emitResult(
  result: CommandResult,
  options: CommandOptions,
): void {
  let completed = result;
  let prepared: PreparedResult;
  try {
    prepared = prepareResult({ result, options });
  } catch {
    completed = preparationFailure(result);
    prepared = prepareResult({ result: completed, options });
  }
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
