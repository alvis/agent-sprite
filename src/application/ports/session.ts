import type { ProviderDriver } from '#application/ports/drivers';
import type {
  GuestChannel,
  GuestExecResult,
} from '#application/ports/guest-channel';
import type { OsFamily } from '#application/ports/os';
import type { OsRelease } from '#domain/guest';
import type { ToolOwner } from '#domain/tools';
import type { WorkstationRecord } from '#domain/workstation';

import type { Secret } from '#kernel/secret';

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

/** the provider facts a setup connection opens sessions with */
export type ConnectionProvider = Pick<
  ProviderDriver,
  | 'images'
  | 'awaitGuestReady'
  | 'openRootShell'
  | 'openGuest'
  | 'serviceBackend'
>;

/** what a setup connection is bound to */
export interface SetupConnectionParams {
  /** the provider that opens the root shell */
  provider: ConnectionProvider;
  /** record of the machine the session opens on */
  workstation: WorkstationRecord;
}

/**
 * the one root setup session a command holds on a workstation: it opens on
 * first use after the guest has booted, and is reopened, ending the lost
 * one, after a transport fault. Only one session holds the guest's setup
 * lock at a time, so the plan runner and the configuration that follows it
 * share this one
 */
export interface SetupSession extends GuestSession {
  /**
   * opens the session unless it is open
   * @param supersedes pid of a lost session whose shell and command the new one ends
   * @returns the open session
   */
  open(supersedes?: number): Promise<GuestSession>;
  /**
   * drops a session a transport fault broke and opens another that ends it
   * @param lost pid of the lost session's shell
   * @returns the new session
   */
  reopen(lost: number): Promise<GuestSession>;
  /** closes the open session, ignoring one already lost */
  close(): Promise<void>;
  /**
   * opens the session for the plan runner, which closes what it opens: the
   * session it is given is this connection's, its closing left to the
   * connection, and a lost session is reopened ending the lost one
   * @param supersedes pid of the session a transport fault broke
   * @returns the session, whose disposal does nothing
   */
  lend(supersedes?: number): Promise<GuestSession>;
  /**
   * builds the guest channel whose commands run over this connection's
   * session, with the provider's channel for reads and spawning
   * @returns the channel
   */
  guest(): Promise<GuestChannel>;
}
