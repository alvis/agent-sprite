import { CommandFault } from '#kernel/faults';
import { checkOperation, currentOperation } from '#kernel/operation';
import { redactResolved } from '#kernel/redaction';

import { SessionTransportFault } from './faults';
import { commandScript, KILL_GRACE_SECONDS, newMarker } from './framing';
import { StatusStream } from './output';

import type {
  GuestExecResult,
  GuestProcess,
} from '#application/ports/guest-channel';
import type {
  GuestSession,
  SessionAwakeHold,
  SessionCommand,
  SessionFamily,
} from '#application/ports/session';
import type { OsRelease } from '#domain/guest';

const MILLISECONDS_PER_SECOND = 1000;
/** time the transport may add to a command's own limit before the session is lost */
const TRANSPORT_MARGIN_MS = 30_000;
/** longest a closing shell may take to exit before it is killed */
const CLOSE_LIMIT_MS = 10_000;
/** the most stderr a failure to start the shell quotes */
const DIAGNOSTIC_LENGTH = 300;

/** a script whose status line the session waits for */
interface Pending {
  /** the marker its status line carries */
  marker: string;
  /** settles the script with its output on both streams */
  resolve: (result: GuestExecResult) => void;
  /** fails the script because the session broke */
  reject: (error: Error) => void;
}

/** a root shell running framed scripts one at a time */
export class ShellSession implements GuestSession {
  readonly #shell: GuestProcess;
  readonly #family: SessionFamily;
  readonly #stdout = new StatusStream();
  readonly #stderr = new StatusStream();
  #release: OsRelease | undefined;
  #pid = 0;
  #pending: Pending | undefined;
  #broken: Error | undefined;
  #hasReported = false;
  #exitCode: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #awakeHold: SessionAwakeHold | undefined;

  /**
   * listens to the shell's streams and lifetime
   * @param shell the root shell the provider opened
   * @param family the family whose shell and account switch the session uses
   */
  constructor(shell: GuestProcess, family: SessionFamily) {
    this.#shell = shell;
    this.#family = family;
    shell.stdout.on('data', (chunk: Buffer | string) => {
      this.#stdout.push(chunk);
      this.#settle();
    });
    shell.stderr.on('data', (chunk: Buffer | string) => {
      this.#stderr.push(chunk);
      this.#settle();
    });
    shell.stdin.on('error', (error: unknown) => {
      this.#fail(
        new SessionTransportFault('The guest shell stopped reading', {
          cause: error,
        }),
      );
    });
    shell.on('error', (error: unknown) => {
      this.#fail(
        new SessionTransportFault('The connection to the guest shell broke', {
          cause: error,
        }),
      );
    });
    shell.on('exit', (code: number) => {
      this.#exitCode = code;
      this.#fail(this.#exitFailure(code));
    });
  }

  /**
   * returns what the guest reported about its OS
   * @returns the guest's OS release
   */
  public get release(): OsRelease {
    if (!this.#release) {
      throw new Error('The session has not probed the guest yet');
    }

    return this.#release;
  }

  /**
   * returns the session shell's pid on the guest
   * @returns the shell's guest PID
   */
  public get pid(): number {
    return this.#pid;
  }

  /**
   * records what the opening learnt
   * @param release what the probe reported about the guest's OS
   * @param pid the shell's pid on the guest
   */
  public start(release: OsRelease, pid: number): void {
    this.#release = release;
    this.#pid = pid;
  }

  /**
   * opens the awake hold keyed by the shell's pid, closed when the session is;
   * like any hold, one the guest refuses only lets the governor count idleness
   * @param hold the commands that open and close the hold
   */
  public async holdAwake(hold: SessionAwakeHold): Promise<void> {
    await this.run(hold.open(this.#pid));
    this.#awakeHold = hold;
  }

  /**
   * runs one command in its own process group as its account
   * @param command argv, account, input, limit and environment
   * @returns its exit status and redacted output
   */
  public async run(command: SessionCommand): Promise<GuestExecResult> {
    const marker = newMarker();
    const script = commandScript({
      command,
      marker,
      runAs: this.#family.runAs(command.account ?? 'root'),
      shell: this.#family.shell,
    });

    return this.script(
      script,
      marker,
      command.timeoutMs + KILL_GRACE_SECONDS * MILLISECONDS_PER_SECOND,
    );
  }

  /**
   * writes a framed script and waits for its status line on both streams
   * @param script the framed script
   * @param marker the marker its status line carries
   * @param limitMs how long the script may take on the guest
   * @returns its exit status and redacted output
   */
  public async script(
    script: string,
    marker: string,
    limitMs: number,
  ): Promise<GuestExecResult> {
    const turn = this.#queue.then(async () =>
      this.#exchange(script, marker, limitMs + TRANSPORT_MARGIN_MS),
    );
    this.#queue = turn.catch(() => undefined);

    return turn;
  }

  /** closes the awake hold, then lets the shell exit, releasing the lock */
  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#broken !== undefined) {
      this.kill();

      return;
    }
    const hold = this.#awakeHold;
    if (hold) {
      await this.run(hold.close(this.#pid)).catch(() => undefined);
    }
    const exited = new Promise<boolean>((resolve) => {
      if (this.#exitCode !== undefined) {
        resolve(true);
      }
      this.#shell.on('exit', () => resolve(true));
    });
    this.#shell.stdin.end('exit 0\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isClosed = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_LIMIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!isClosed) {
      this.kill();
    }
  }

  /** ends the shell and its transport */
  public kill(): void {
    this.#broken ??= new SessionTransportFault('The session was closed');
    this.#shell.kill();
  }

  /**
   * writes one script and settles when both streams report its status, the
   * transport breaks, the operation is cancelled or the limit passes
   * @param script the framed script
   * @param marker the marker its status line carries
   * @param limitMs how long to wait before the session is lost
   * @returns its exit status and redacted output
   */
  async #exchange(
    script: string,
    marker: string,
    limitMs: number,
  ): Promise<GuestExecResult> {
    if (this.#broken !== undefined) {
      throw this.#broken;
    }
    const operation = currentOperation();
    checkOperation(operation);

    return new Promise<GuestExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(
          new SessionTransportFault(
            `The guest reported no status within ${limitMs} ms`,
          ),
        );
        this.#shell.kill();
      }, limitMs);
      const abort = (): void => {
        try {
          checkOperation(operation);
        } catch (reason) {
          this.#fail(reason as Error);
        }
        this.#shell.kill();
      };
      const settle = (): void => {
        clearTimeout(timer);
        operation?.signal.removeEventListener('abort', abort);
      };
      this.#pending = {
        marker,
        resolve: (result) => {
          settle();
          resolve(result);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      operation?.signal.addEventListener('abort', abort, { once: true });
      this.#shell.stdin.write(script, (error) => {
        if (error) {
          this.#fail(
            new SessionTransportFault('The guest shell stopped reading', {
              cause: error,
            }),
          );
        }
      });
      this.#settle();
    });
  }

  /** settles the pending script once both streams carry its status line */
  #settle(): void {
    const pending = this.#pending;
    if (!pending) {
      return;
    }
    try {
      const stdout = this.#stdout.take(pending.marker);
      const stderr = this.#stderr.take(pending.marker);
      if (!stdout || !stderr) {
        return;
      }
      if (stdout.status !== stderr.status) {
        throw new SessionTransportFault(
          'The guest reported two statuses for one command',
        );
      }
      this.#hasReported = true;
      this.#pending = undefined;
      pending.resolve({
        exitCode: stdout.status,
        stdout: redactResolved(stdout.output),
        stderr: redactResolved(stderr.output),
      });
    } catch (error) {
      this.#fail(error as Error);
      this.#shell.kill();
    }
  }

  /**
   * marks the session lost and fails the pending script
   * @param error why the session can no longer be trusted
   */
  #fail(error: Error): void {
    this.#broken ??= error;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
  }

  /**
   * explains a shell that exited: before its first status line the shell
   * could not start, which no retry mends; afterwards the session is lost
   * @param code the shell's exit status
   * @returns the failure
   */
  #exitFailure(code: number): Error {
    if (this.#hasReported) {
      return new SessionTransportFault(
        `The guest shell exited with status ${code} during the session`,
      );
    }
    const diagnostic = redactResolved(this.#stderr.unclaimed())
      .slice(-DIAGNOSTIC_LENGTH)
      .trim();

    return new CommandFault({
      code: 'PREFLIGHT',
      message: `The guest could not start ${this.#family.shell} as root (status ${code})`,
      ...(diagnostic ? { details: [diagnostic] } : {}),
    });
  }
}
