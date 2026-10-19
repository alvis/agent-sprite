import { projectCreate, projectCreateFailure } from './create';
import { projectCredentialSave } from './credentials';
import { projectDoctor } from './doctor';
import { projectError } from './failure';
import { projectList } from './list';
import { projectSetup, projectSetupFailure } from './setup';
import { projectShow } from './show';
import { projectTerminate } from './terminate';

import type { CommandResult, CommandSuccess } from '#application/result';

import type { FailureOutput, ResultOutput, SuccessOutput } from './envelope';

type Failed = Exclude<CommandResult, { ok: true }>;

/**
 * projects a command result to the frozen output contract
 * @param result internal result
 * @returns output result, ready for the serializer to redact and encode
 */
export function projectResult(result: CommandResult): ResultOutput {
  return result.ok ? projectSuccess(result) : projectFailure(result);
}

/**
 * projects a successful result for its command
 * @param result internal success
 * @returns output success
 */
function projectSuccess(result: CommandSuccess): SuccessOutput {
  const retainedCredential = result.retainedCredential
    ? projectCredentialSave(result.retainedCredential)
    : undefined;
  switch (result.command) {
    case 'create':
      return {
        command: 'create',
        ok: true,
        data: projectCreate(result.data),
        retainedCredential,
      };
    case 'setup':
      return {
        command: 'setup',
        ok: true,
        data: projectSetup(result.data),
        retainedCredential,
      };
    case 'list':
      return {
        command: 'list',
        ok: true,
        data: projectList(result.data),
        retainedCredential,
      };
    case 'show':
      return {
        command: 'show',
        ok: true,
        data: projectShow(result.data),
        retainedCredential,
      };
    case 'terminate':
      return {
        command: 'terminate',
        ok: true,
        data: projectTerminate(result.data),
        retainedCredential,
      };
    case 'doctor':
      return {
        command: 'doctor',
        ok: true,
        data: projectDoctor(result.data),
        retainedCredential,
      };
    default:
      return unreachable(result);
  }
}

/**
 * projects a failed result with the observations its command keeps
 * @param result internal failure
 * @returns output failure
 */
function projectFailure(result: Failed): FailureOutput {
  const error = projectError(result.error);
  switch (result.command) {
    case null:
      return { command: null, ok: false, error };
    case 'create':
      return {
        command: 'create',
        ok: false,
        error,
        data: optional(result.data, projectCreateFailure),
      };
    case 'setup':
      return {
        command: 'setup',
        ok: false,
        error,
        data: optional(result.data, projectSetupFailure),
      };
    case 'list':
      return { command: 'list', ok: false, error };
    case 'show':
      return { command: 'show', ok: false, error };
    case 'terminate':
      return {
        command: 'terminate',
        ok: false,
        error,
        data: optional(result.data, projectTerminate),
      };
    case 'doctor':
      return {
        command: 'doctor',
        ok: false,
        error,
        data: optional(result.data, projectDoctor),
      };
    default:
      return unreachable(result);
  }
}

/**
 * projects a value that a failure may not carry
 * @param value internal value
 * @param project projector for a present value
 * @returns the projection, or undefined when absent
 */
function optional<T, V>(
  value: T | undefined,
  project: (present: T) => V,
): V | undefined {
  return value === undefined ? undefined : project(value);
}

/**
 * fails when a command has no projection, which the compiler rules out
 * @param result the unhandled result
 */
function unreachable(result: never): never {
  throw new Error(`No output projection for ${JSON.stringify(result)}`);
}
