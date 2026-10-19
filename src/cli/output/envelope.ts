import type { CommandName } from '#kernel/commands';

import type { CreateDataOutput, CreateFailureDataOutput } from './create';
import type { CredentialSaveOutput } from './credentials';
import type { DoctorDataOutput } from './doctor';
import type { ErrorOutput } from './failure';
import type { ListDataOutput } from './list';
import type { SetupDataOutput, SetupFailureDataOutput } from './setup';
import type { ShowDataOutput } from './show';
import type { TerminateDataOutput } from './terminate';

/** success payload each command reports under schema version 1 */
export interface CommandDataOutput {
  create: CreateDataOutput;
  setup: SetupDataOutput;
  list: ListDataOutput;
  show: ShowDataOutput;
  terminate: TerminateDataOutput;
  doctor: DoctorDataOutput;
}

/** observations each command keeps after failure under schema version 1 */
export interface CommandFailureDataOutput {
  create: CreateFailureDataOutput;
  setup: SetupFailureDataOutput;
  list: never;
  show: never;
  terminate: TerminateDataOutput;
  doctor: DoctorDataOutput;
}

/** a successful command with the credential it retained */
export type SuccessOutput = {
  [Command in CommandName]: {
    command: Command;
    ok: true;
    data: CommandDataOutput[Command];
    retainedCredential?: CredentialSaveOutput;
    error?: never;
  };
}[CommandName];

/** a failed command, including a parser failure with no command */
export type FailureOutput =
  | {
      [Command in CommandName]: {
        command: Command;
        ok: false;
        error: ErrorOutput;
        data?: CommandFailureDataOutput[Command];
      };
    }[CommandName]
  | {
      command: null;
      ok: false;
      error: ErrorOutput;
      data?: never;
    };

/** the contract every command result is projected to before serialization */
export type ResultOutput = SuccessOutput | FailureOutput;
