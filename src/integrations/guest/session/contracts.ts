import type { GuestExecResult } from '#drivers/guest-channel';
import type { OsFamily, OsRelease } from '#os/contracts';
import type { ToolOwner } from '#tools/contracts';

import type { Secret } from './secret.js';

/** standard input of one session command; absent means `/dev/null` */
export type StepInput =
  | {
      /** UTF-8 text, delivered byte for byte */
      kind: 'text';
      /** the text */
      value: string;
    }
  | {
      /** binary data */
      kind: 'bytes';
      /** the bytes */
      value: Uint8Array;
    }
  | {
      /** a credential, which never touches a disk */
      kind: 'secret';
      /** the credential */
      value: Secret;
      /**
       * `stdin` pipes it to the command; `shm-file` writes it to a 0600 file
       * in a private directory under `/dev/shm`, removed when the command
       * ends, and names the file in `OPEN_AGENT_SECRET_FILE`
       */
      as: 'stdin' | 'shm-file';
    };

/** one command a session runs, as single-quoted argv in its own process group */
export interface SessionCommand {
  /** program followed by its arguments */
  argv: readonly [string, ...string[]];
  /** account the command runs as; root when absent */
  account?: ToolOwner;
  /** standard input */
  input?: StepInput;
  /** limit after which the command's process group is terminated, then killed */
  timeoutMs: number;
  /** additional environment variables; never a secret, which `env` would expose in its arguments */
  environment?: Readonly<Record<string, string>>;
}

/** a root shell on the guest that runs framed commands one at a time */
export interface GuestSession extends AsyncDisposable {
  /** what the guest reported about its OS when the session opened */
  readonly release: OsRelease;
  /** process id of the session's shell on the guest */
  readonly pid: number;
  /**
   * runs one command; a non-zero exit is a result, a broken transport a
   * transient provider fault
   * @param command argv, account, input, limit and environment
   * @returns its exit status and captured, redacted output
   */
  run(command: SessionCommand): Promise<GuestExecResult>;
}

/** what a session needs from the guest's OS family */
export type SessionFamily = Pick<
  OsFamily,
  'id' | 'matches' | 'shell' | 'sessionCommands' | 'runAs'
>;

/**
 * the commands that hold the workstation awake for as long as a session's
 * shell lives; the idle governor fills it in, keyed by the shell's pid
 */
export interface SessionAwakeHold {
  /**
   * renders the command that opens the hold
   * @param pid the session shell's pid
   * @returns the command
   */
  open(pid: number): SessionCommand;
  /**
   * renders the command that closes the hold
   * @param pid the session shell's pid
   * @returns the command
   */
  close(pid: number): SessionCommand;
}
