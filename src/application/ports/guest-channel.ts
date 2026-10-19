import type { Readable, Writable } from 'node:stream';

import type { GuestCommand } from '#domain/guest-command';
import type { GuestServiceState, ServiceDefinition } from '#domain/services';

/** captured outcome of one guest command */
export interface GuestExecResult {
  /** process exit status */
  exitCode: number;
  /** captured standard output */
  stdout: string;
  /** captured standard error */
  stderr: string;
}

/** streaming duplex guest process for the guest transaction worker */
export interface GuestProcess {
  /** process standard input */
  readonly stdin: Writable;
  /** process standard output */
  readonly stdout: Readable;
  /** process standard error */
  readonly stderr: Readable;
  /**
   * observes process exit
   * @param event exit event
   * @param listener receives the exit status
   * @returns this process
   */
  on(event: 'exit', listener: (code: number) => void): this;
  /**
   * observes transport failure
   * @param event error event
   * @param listener receives the failure
   * @returns this process
   */
  on(event: 'error', listener: (error: unknown) => void): this;
  /** terminates the process and its transport */
  kill(): void;
}

/** provider services, or runit's when the service backend is runit */
export interface GuestServiceControl {
  /**
   * reads every service and its current state from one complete registry
   * snapshot, rejecting partial or malformed provider evidence
   * @returns current services
   */
  list(): Promise<GuestServiceState[]>;
  /**
   * registers a definition, replacing a different existing one, and starts it
   * @param definition desired service
   */
  ensure(definition: ServiceDefinition): Promise<void>;
  /**
   * stops a running service; a failure the service itself reports while
   * stopping is returned rather than thrown, so callers keep their own wording
   * @param name service identifier
   * @returns true when the service stopped without reporting a failure
   */
  stop(name: string): Promise<boolean>;
  /**
   * unregisters a service
   * @param name service identifier
   */
  remove(name: string): Promise<void>;
}

/** the provider-neutral way core and drivers act on the guest */
export interface GuestChannel {
  /** service management */
  readonly services: GuestServiceControl;
  /**
   * runs a command and returns its output and exit status
   * @param command command to run
   * @returns captured outcome
   */
  exec(command: GuestCommand): Promise<GuestExecResult>;
  /**
   * starts a streaming duplex process
   * @param command command to start
   * @returns the running process
   */
  spawn(command: GuestCommand): GuestProcess;
  /**
   * tells whether a guest path exists
   * @param path absolute guest path
   * @returns true when the path exists
   */
  exists(path: string): Promise<boolean>;
  /**
   * reads a guest file as UTF-8 text
   * @param path absolute guest path
   * @returns file contents
   */
  read(path: string): Promise<string>;
  /**
   * rejects when a provider-enforced network policy would conflict with the
   * guest replacing its own DNS configuration; never changes the policy
   */
  assertUnrestrictedNetwork(): Promise<void>;
}
