import type { CredentialSaveResult } from '#integrations/credentials';

import type { CommandName, CommandError } from './command/contracts.js';
import type { CommandData, CommandFailureData } from './command/data.js';

/** metadata retained beside the action result */
interface ResultOutput {
  retainedCredential?: CredentialSaveResult;
}

/** success is correlated with its executed command and concrete payload */
export type CommandSuccess = {
  [Command in CommandName]: ResultOutput & {
    command: Command;
    ok: true;
    data: CommandData[Command];
    error?: never;
  };
}[CommandName];

/** failures retain only the observations meaningful for that command */
type CommandFailure =
  | {
      [Command in CommandName]: {
        command: Command;
        ok: false;
        error: CommandError;
        data?: CommandFailureData[Command];
        output?: never;
      };
    }[CommandName]
  | {
      command: null;
      ok: false;
      error: CommandError;
      data?: never;
      output?: never;
    };

/** discriminated outcome returned by every command and parser boundary */
export type CommandResult = CommandSuccess | CommandFailure;
