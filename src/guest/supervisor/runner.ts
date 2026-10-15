import { setTimeout as delay } from 'node:timers/promises';

import { identifyProcess } from '../idle/process-identity.js';

import { clearRestart, describeExit, restartDelay } from './entries.js';
import { SupervisorFault } from './fault.js';
import {
  commandLine,
  endProcess,
  serviceLogPath,
  settlesWithin,
  signalGroup,
  spawnInGroup,
} from './processes.js';
import { writeChildren } from './store.js';

import type { ChildProcess } from 'node:child_process';

import type {
  ProcessExit,
  RunningProcess,
  ServiceEntry,
  SupervisorParams,
} from './entries.js';

// guest kernel: imports only Node built-ins and other guest code. The runner
// keeps the registered services' processes in step with what they should be:
// a service starts once every service it needs runs, a process that exits is
// started again after a growing delay, and every running child is recorded so
// a supervisor started again in the same boot can end what it left

/** a process that ran this long resets its restart delay */
const STABLE_UPTIME_MS = 60_000;
/** how long a started process must keep running before an ensure succeeds */
const STARTUP_WINDOW_MS = 2_000;
/** how long an ensure waits for its service to start */
const ENSURE_WAIT_MS = 30_000;
/** how long a supervisor shutting down waits before it kills, inside the provider's own stop timeout */
const SHUTDOWN_GRACE_MS = 4_000;
const POLL_MS = 100;

/** runs the processes of the registered services */
export class ServiceRunner {
  readonly #params: SupervisorParams;
  readonly #entries: ReadonlyMap<string, ServiceEntry>;
  #childrenWrite: Promise<void> = Promise.resolve();
  #isShuttingDown = false;

  /**
   * binds the runner to the supervisor's guest and registered services
   * @param params directories, accounts, log, clock and trust check
   * @param entries the registered services, which the supervisor changes
   */
  constructor(
    params: SupervisorParams,
    entries: ReadonlyMap<string, ServiceEntry>,
  ) {
    this.#params = params;
    this.#entries = entries;
  }

  /**
   * starts every service that should run and can: it is not running,
   * starting, held or waiting out a restart delay, and every service it
   * needs runs
   */
  public reconcile(): void {
    if (this.#isShuttingDown) {
      return;
    }
    for (const entry of this.#entries.values()) {
      if (
        entry.desired === 'running' &&
        !entry.running &&
        !entry.isLaunching &&
        !entry.isHeld &&
        entry.restart === undefined &&
        entry.definition.needs.every((need) => this.#isRunning(need))
      ) {
        void this.#launch(entry);
      }
    }
  }

  /**
   * waits until a service's process has run through the startup window
   * @param entry the registered service
   * @throws {SupervisorFault} when it ends early or does not start in time
   */
  public async awaitStartup(entry: ServiceEntry): Promise<void> {
    const { name } = entry.definition;
    const deadline = this.#params.now() + ENSURE_WAIT_MS;
    for (;;) {
      if (this.#entries.get(name) !== entry || entry.desired !== 'running') {
        throw new SupervisorFault(
          'failed',
          `${name} was stopped while starting`,
        );
      }
      const { running } = entry;
      if (running && !running.isStopping) {
        const remaining =
          STARTUP_WINDOW_MS - (this.#params.now() - running.startedAt);
        if (!(await settlesWithin(running.exited, remaining))) {
          return;
        }
        throw new SupervisorFault(
          'failed',
          `${name} exited during startup (${entry.lastOutcome ?? 'unknown'})`,
        );
      }
      if (this.#params.now() >= deadline) {
        throw new SupervisorFault(
          'failed',
          `${name} did not start: ${this.#waitingReason(entry)}`,
        );
      }
      await delay(POLL_MS);
    }
  }

  /**
   * ends a service's process, killing its group when it outlasts the grace
   * @param entry the registered service
   * @param graceMs how long the group may take to end
   * @returns whether the process ended
   */
  public async terminate(
    entry: ServiceEntry,
    graceMs: number,
  ): Promise<boolean> {
    const { running } = entry;
    if (!running) {
      return true;
    }

    return endProcess(running, graceMs, () => {
      this.#params.log.write({
        service: entry.definition.name,
        event: 'kill',
        pid: running.pid,
        after_ms: graceMs,
      });
    });
  }

  /**
   * ends every service at once, for the supervisor's own exit, and starts
   * nothing afterwards
   */
  public async shutdown(): Promise<void> {
    this.#isShuttingDown = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) {
      clearRestart(entry);
    }
    await Promise.all(
      entries.map(async (entry) => this.terminate(entry, SHUTDOWN_GRACE_MS)),
    );
    await this.#childrenWrite;
  }

  /**
   * explains why a service that should run does not
   * @param entry the registered service
   * @returns non-secret reason
   */
  #waitingReason(entry: ServiceEntry): string {
    if (entry.restart !== undefined) {
      return `restarting after ${entry.lastOutcome ?? 'a failure'}`;
    }
    const waiting = entry.definition.needs.filter(
      (need) => !this.#isRunning(need),
    );

    return waiting.length > 0
      ? `waiting for ${waiting.join(', ')}`
      : 'still starting';
  }

  /**
   * tells whether a service has a process that is not being ended
   * @param name service identifier
   * @returns whether it runs
   */
  #isRunning(name: string): boolean {
    const running = this.#entries.get(name)?.running;

    return running !== undefined && !running.isStopping;
  }

  /**
   * checks a service's command line and starts it, unless the service was
   * stopped, held or replaced while the check ran
   * @param entry the registered service
   */
  async #launch(entry: ServiceEntry): Promise<void> {
    const { definition } = entry;
    entry.isLaunching = true;
    const line = await commandLine(this.#params, definition).then(
      (argv) => ({ argv }),
      (error: unknown) => ({ refusal: (error as Error).message }),
    );
    entry.isLaunching = false;
    if (
      this.#isShuttingDown ||
      this.#entries.get(definition.name) !== entry ||
      entry.definition !== definition ||
      entry.desired !== 'running' ||
      entry.isHeld
    ) {
      this.reconcile();

      return;
    }
    if ('refusal' in line) {
      this.#refuse(entry, line.refusal);

      return;
    }
    this.#spawn(entry, line.argv);
    this.reconcile();
  }

  /**
   * records a start that could not happen and arms the next attempt
   * @param entry the registered service
   * @param reason why it could not start
   * @param outcome how the attempt is reported while the service waits
   */
  #refuse(
    entry: ServiceEntry,
    reason: string,
    outcome = `refused: ${reason}`,
  ): void {
    entry.lastOutcome = outcome;
    this.#params.log.write({
      service: entry.definition.name,
      event: 'refused',
      reason,
      restart_in_ms: this.#scheduleRestart(entry),
    });
  }

  /**
   * starts a service's process in a process group of its own, its output
   * appended to the service's root-only log
   * @param entry the registered service
   * @param argv the program followed by its arguments
   */
  #spawn(entry: ServiceEntry, argv: readonly string[]): void {
    const { definition } = entry;
    const { accounts, stateDirectory, now, log, procRoot } = this.#params;
    let child: ChildProcess;
    try {
      child = spawnInGroup(
        argv,
        accounts[definition.account],
        serviceLogPath(stateDirectory, definition.name),
      );
    } catch (error) {
      const { message } = error as Error;
      this.#refuse(entry, message, `not started: ${message}`);

      return;
    }
    const exit = Promise.withResolvers<ProcessExit>();
    child.once('exit', (code, signal) => {
      exit.resolve({ code, signal });
    });
    child.once('error', (error) => {
      exit.resolve({ code: null, signal: null, error });
    });
    const running: RunningProcess = {
      pid: child.pid ?? 0,
      startedAt: now(),
      exited: exit.promise.then((ended) => {
        this.#exited(entry, running, ended);
      }),
      isStopping: false,
    };
    entry.running = running;
    log.write({
      service: definition.name,
      event: 'start',
      pid: running.pid,
      account: definition.account,
    });
    void identifyProcess(running.pid, procRoot).then((identity) => {
      running.identity = identity;
      this.#saveChildren();
    });
  }

  /**
   * records how a process ended, ends whatever it left in its process group,
   * and starts the service again after its delay unless it was stopped
   * @param entry the registered service
   * @param running the process that ended
   * @param exit how it ended
   */
  #exited(
    entry: ServiceEntry,
    running: RunningProcess,
    exit: ProcessExit,
  ): void {
    if (entry.running !== running) {
      return;
    }
    entry.running = undefined;
    signalGroup(running.pid, 'SIGKILL');
    this.#saveChildren();
    const uptime = this.#params.now() - running.startedAt;
    entry.lastOutcome = describeExit(exit);
    const isRestarting =
      !running.isStopping &&
      !this.#isShuttingDown &&
      !entry.isHeld &&
      entry.desired === 'running' &&
      this.#entries.get(entry.definition.name) === entry;
    if (isRestarting && uptime >= STABLE_UPTIME_MS) {
      entry.failures = 0;
    }
    this.#params.log.write({
      service: entry.definition.name,
      event: 'exit',
      pid: running.pid,
      code: exit.code ?? undefined,
      signal: exit.signal ?? undefined,
      error: exit.error?.message,
      uptime_ms: uptime,
      restart_in_ms: isRestarting ? this.#scheduleRestart(entry) : undefined,
    });
    this.reconcile();
  }

  /**
   * arms a service's restart after a delay that doubles with each failure in
   * a row, up to its limit
   * @param entry the registered service
   * @returns the delay in milliseconds
   */
  #scheduleRestart(entry: ServiceEntry): number {
    entry.failures += 1;
    const wait = restartDelay(entry.failures);
    clearRestart(entry);
    entry.restart = setTimeout(() => {
      entry.restart = undefined;
      this.reconcile();
    }, wait);

    return wait;
  }

  /** records every running child whose identity is known, one write after another */
  #saveChildren(): void {
    this.#childrenWrite = this.#childrenWrite
      .then(async () =>
        writeChildren(
          this.#params.runDirectory,
          [...this.#entries.values()].flatMap(({ definition, running }) =>
            running?.identity
              ? [{ name: definition.name, ...running.identity }]
              : [],
          ),
        ),
      )
      .catch((error: unknown) => {
        this.#params.log.write({
          supervisor: 'children',
          failure: (error as Error).message,
        });
      });
  }
}
