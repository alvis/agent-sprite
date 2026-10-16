import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { PassThrough } from 'node:stream';

import { ProviderFault } from '#drivers/failures';

import { flyctlAgent } from './agent';
import { flyctlEnvironment } from './flyctl';
import { InBandStatusFilter, verifiedStatus } from './in-band';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { GuestProcess } from '#drivers/guest-channel';

/** events a guest process reports */
interface GuestProcessEvents {
  /** process exit with its in-band status */
  exit: [code: number];
  /** transport failure, already provider-neutral */
  error: [error: unknown];
}

/** how one SSH session is started once its token is known */
interface SshSession {
  /** flyctl arguments, ending with the in-band command line */
  arguments: readonly string[];
  /** marker the in-band status follows */
  marker: string;
  /** resolves the app's SSH-scoped token */
  token: () => Promise<string>;
  /** the flyctl executable */
  program: string;
}

/** how one session ended */
type Settlement = { exit: number } | { error: unknown };

const TRANSPORT_DIAGNOSTIC_LENGTH = 300;
const SIGNAL_EXIT_BASE = 128;
/** the status a shell reports for a command ended by SIGTERM, as kill does */
export const KILLED_STATUS = SIGNAL_EXIT_BASE + constants.signals.SIGTERM;

/**
 * a `fly ssh console` session presented as a provider-neutral process: its
 * exit status is the one the guest reported in band, accepted only when
 * flyctl's own exit agrees, and it settles exactly once
 */
export class FlyGuestProcess
  extends EventEmitter<GuestProcessEvents>
  implements GuestProcess
{
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  #child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  #killed = false;
  #settled = false;

  /**
   * starts the session as soon as its token is resolved
   * @param session flyctl arguments, marker and token source
   */
  constructor(session: SshSession) {
    super();
    session
      .token()
      .then(async (token) => this.#run(session, token))
      .catch((error: unknown) => this.#settle({ error: startFailure(error) }));
  }

  /**
   * terminates the session and its transport; the process then exits as one
   * a signal ended, even when it had not started yet
   */
  public kill(): void {
    if (this.#killed || this.#settled) {
      return;
    }
    this.#killed = true;
    this.stdin.destroy();
    if (this.#child) {
      this.#child.kill();
    } else {
      // settles after the caller's current tick, as a child process exit does
      process.nextTick(() => this.#settle({ exit: KILLED_STATUS }));
    }
  }

  /**
   * runs the session while it holds the private flyctl agent
   * @param session flyctl arguments and marker
   * @param token the app's SSH-scoped token
   */
  async #run(session: SshSession, token: string): Promise<void> {
    if (this.#killed) {
      return;
    }
    const settlement = await flyctlAgent.hold(async () =>
      this.#killed
        ? { exit: KILLED_STATUS }
        : new Promise<Settlement>((resolve) => {
            this.#start(session, token, resolve);
          }),
    );
    this.#settle(settlement);
  }

  /**
   * spawns flyctl and relays its streams, separating the in-band status
   * @param session flyctl arguments and marker
   * @param token the app's SSH-scoped token
   * @param ended receives how the session ended, once
   */
  #start(
    session: SshSession,
    token: string,
    ended: (settlement: Settlement) => void,
  ): void {
    const child = spawn(session.program, [...session.arguments], {
      env: flyctlEnvironment(token),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    const filter = new InBandStatusFilter(session.marker);
    let transport = '';
    this.stdin.pipe(child.stdin);
    child.stdin.on('error', () => {
      // the session closed its input; its exit reports the outcome
    });
    child.stdout.pipe(this.stdout);
    child.stderr.on('data', (chunk: Buffer) => {
      transport = `${transport}${chunk.toString()}`.slice(
        -TRANSPORT_DIAGNOSTIC_LENGTH,
      );
      writeOpen(this.stderr, filter.push(chunk));
    });
    child.stderr.on('end', () => endOpen(this.stderr, filter.end()));
    child.on('error', (error) => ended({ error: startFailure(error) }));
    child.on('close', (code) => {
      if (this.#killed) {
        ended({ exit: KILLED_STATUS });

        return;
      }
      try {
        ended({ exit: verifiedStatus(filter.status, code, transport) });
      } catch (error) {
        ended({ error });
      }
    });
  }

  /**
   * reports the outcome once and closes the output streams
   * @param settlement exit status or failure
   */
  #settle(settlement: Settlement): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#child?.stdout.unpipe(this.stdout);
    endOpen(this.stdout);
    endOpen(this.stderr);
    if ('exit' in settlement) {
      this.emit('exit', settlement.exit);
    } else {
      this.emit('error', settlement.error);
    }
  }
}

/**
 * describes a session that could not start in provider-neutral terms
 * @param error failure from the token source or the spawn
 * @returns a provider fault
 */
function startFailure(error: unknown): ProviderFault {
  return error instanceof ProviderFault
    ? error
    : new ProviderFault({
        code: 'failed',
        message: `Could not start the SSH session: ${(error as Error).message}`,
        cause: error,
      });
}

/**
 * writes to a stream only while it still accepts writes
 * @param stream output stream
 * @param chunk bytes to write
 */
function writeOpen(stream: PassThrough, chunk: Buffer): void {
  if (!stream.writableEnded && !stream.destroyed) {
    stream.write(chunk);
  }
}

/**
 * ends a stream unless it has already ended
 * @param stream output stream
 * @param chunk final bytes, if any
 */
function endOpen(stream: PassThrough, chunk?: Buffer): void {
  if (!stream.writableEnded && !stream.destroyed) {
    stream.end(chunk);
  }
}
