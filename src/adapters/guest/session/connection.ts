import { sessionAwakeHold } from '#adapters/guest/governor';
import { OS_FAMILIES } from '#adapters/guest/os/families';

import { sessionGuest } from '#adapters/guest/platform/session/channel';
import { openWorkstationSession } from '#adapters/guest/platform/session/open';
import { SERVICE_BACKENDS } from '#adapters/guest/services/backends';

import type { SessionGuest } from '#adapters/guest/platform/session/channel';
import type { GuestExecResult } from '#application/ports/guest-channel';
import type {
  ConnectionProvider,
  GuestSession,
  SessionCommand,
  SetupSession,
} from '#application/ports/session';
import type { OsRelease } from '#domain/guest';
import type { WorkstationRecord } from '#domain/workstation';

/**
 * the one root setup session a command holds on a workstation: it opens on
 * first use after the guest has booted, and is reopened, ending the lost
 * one, after a transport fault. Only one session holds the guest's setup
 * lock at a time, so the plan runner and the configuration that follows it
 * share this one
 */
export class SetupConnection implements SetupSession {
  readonly #provider: ConnectionProvider;
  readonly #workstation: WorkstationRecord;
  #session: GuestSession | undefined;

  /**
   * binds the connection to a workstation without opening a session
   * @param provider the provider that opens the root shell
   * @param workstation record of the machine the session opens on
   */
  constructor(provider: ConnectionProvider, workstation: WorkstationRecord) {
    this.#provider = provider;
    this.#workstation = workstation;
  }

  /**
   * what the guest reported about its OS when the session opened
   * @returns the OS release the guest probe reported
   * @throws {Error} before the session opened
   */
  public get release(): OsRelease {
    return this.#current().release;
  }

  /**
   * process id of the session's shell on the guest
   * @returns process id of the root shell on the guest
   * @throws {Error} before the session opened
   */
  public get pid(): number {
    return this.#current().pid;
  }

  /**
   * opens the session unless it is open
   * @param supersedes pid of a lost session whose shell and command the new one ends
   * @returns the open session
   */
  public async open(supersedes?: number): Promise<GuestSession> {
    this.#session ??= await openWorkstationSession({
      provider: this.#provider,
      workstation: this.#workstation,
      family: OS_FAMILIES[this.#provider.images[0].family],
      awakeHold: sessionAwakeHold,
      ...(supersedes === undefined ? {} : { supersedes }),
    });

    return this.#session;
  }

  /**
   * drops a session a transport fault broke and opens another that ends it
   * @param lost pid of the lost session's shell
   * @returns the new session
   */
  public async reopen(lost: number): Promise<GuestSession> {
    await this.close();

    return this.open(lost);
  }

  /**
   * runs one command in the session, opening it first when needed
   * @param command argv, account, input, limit and environment
   * @returns its exit status and redacted output
   */
  public async run(command: SessionCommand): Promise<GuestExecResult> {
    return (await this.open()).run(command);
  }

  /** closes the open session, ignoring one already lost */
  public async close(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    try {
      await session?.[Symbol.asyncDispose]();
    } catch {
      // a session already lost has nothing left to close
    }
  }

  /** closes the open session */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * opens the session for the plan runner, which closes what it opens: the
   * session it is given is this connection's, its closing left to the
   * connection, and a lost session is reopened ending the lost one
   * @param supersedes pid of the session a transport fault broke
   * @returns the session, whose disposal does nothing
   */
  public async lend(supersedes?: number): Promise<GuestSession> {
    if (supersedes !== undefined) {
      await this.reopen(supersedes);
    }
    await this.open();

    return {
      release: this.release,
      pid: this.pid,
      run: async (command) => this.run(command),
      [Symbol.asyncDispose]: async () => undefined,
    };
  }

  /**
   * builds the guest channel whose commands run over this connection's
   * session, with the provider's channel for reads and spawning
   * @returns the channel
   */
  public async guest(): Promise<SessionGuest> {
    await this.open();

    const channel = await this.#provider.openGuest(this.#workstation);

    return sessionGuest(
      this,
      channel,
      this.#provider.serviceBackend === 'provider'
        ? channel.services
        : SERVICE_BACKENDS[this.#provider.serviceBackend].control(this),
    );
  }

  /**
   * the open session
   * @returns it
   * @throws {Error} before it opened
   */
  #current(): GuestSession {
    if (!this.#session) {
      throw new Error('The setup session is not open');
    }

    return this.#session;
  }
}
