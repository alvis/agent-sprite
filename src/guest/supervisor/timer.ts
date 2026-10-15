import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';

import { settlesWithin } from './processes.js';
import { MAINTENANCE_TIMER } from './protocol.js';

import type { GovernorState } from '../idle/state.js';

import type { SupervisorLog } from './log.js';
import type { SupervisedServiceState } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The supervisor's timer replaces cron on a provider whose services
// it supervises: every pass starts the shared update entry, whose updater ends
// at once when no update is due, and ticks the idle
// governor; the next pass is armed only once a pass ends, so passes never
// overlap and the gap between ticks stays well under the governor's limit. A
// pass that outlasts its deadline is abandoned and the timer arms the next one
// rather than ending the supervisor: the supervisor also holds the services,
// and a hung maintenance step is no reason to restart them

/** how often the timer runs a pass: every minute, as the cron entry did */
export const TIMER_INTERVAL_MS = 60_000;
/**
 * a pass running longer than this has hung: the timer logs it, abandons it and
 * arms the next pass. A pass that ended no later than this after its start
 * keeps the gap between two ticks under the governor's three minutes
 */
export const PASS_DEADLINE_MS = 90_000;
/**
 * how long a pass waits for the update entry it just started to end before it
 * judges an update is running: the entry ends within moments when no check is
 * due, and runs on while the updater works
 */
export const UPDATE_SETTLE_MS = 5_000;
/** abandoned passes still running at which a new pass is not started */
const ABANDONED_LIMIT = 3;
/** the shell every update entry runs in */
const SHELL = '/bin/sh';

/** the update schedule the timer runs */
export interface UpdateSchedule {
  /** a file the installer writes; the schedule runs only once it exists */
  readyFile: string;
  /** the shell command line of one update check */
  command: string;
  /** files the check runs as root, each of which must be root-controlled */
  trusted: readonly string[];
  /** the environment the check starts with */
  environment: Readonly<Record<string, string>>;
}

/** what the timer runs and where it records what happened */
export interface MaintenanceParams {
  /** milliseconds from the end of one pass to the start of the next */
  intervalMs: number;
  /** milliseconds a pass may run before it is abandoned; the default when absent */
  passDeadlineMs?: number;
  /** milliseconds a pass waits for the update entry to end; the default when absent */
  updateSettleMs?: number;
  /** where the timer records what it did */
  log: SupervisorLog;
  /** the update schedule */
  update: UpdateSchedule;
  /** current epoch milliseconds */
  now: () => number;
  /** resolves a path root runs to a file only root controls, or throws */
  trust: (path: string) => Promise<string>;
  /** runs one governed tick and returns the state it recorded */
  tick: () => Promise<GovernorState>;
  /** cuts the logs that have grown beyond their limit */
  trim: () => Promise<void>;
}

/** the supervisor's maintenance timer */
export class MaintenanceTimer {
  readonly #params: MaintenanceParams;
  readonly #startedAt: number;
  #timer?: NodeJS.Timeout;
  #isStopped = false;
  #abandoned = 0;
  #update?: Promise<void>;
  #lastAdapterAt?: string;
  #lastNotes = '';

  /**
   * binds the timer to its schedule, governor and log
   * @param params interval, log, update schedule, clock, trust, tick and trim
   */
  constructor(params: MaintenanceParams) {
    this.#params = params;
    this.#startedAt = params.now();
  }

  /** runs the first pass now and every later pass an interval after the last ends */
  public start(): void {
    this.#arm(0);
  }

  /** stops arming passes; a pass already running finishes */
  public stop(): void {
    this.#isStopped = true;
    clearTimeout(this.#timer);
  }

  /**
   * reports the timer as the supervisor lists it beside its services: running
   * unless it was stopped or an abandoned pass has still not ended
   * @returns its listing as a supervised service
   */
  public state(): SupervisedServiceState {
    return {
      name: MAINTENANCE_TIMER,
      status: this.#isStopped || this.#abandoned > 0 ? 'failed' : 'running',
      needs: [],
      startedAt: new Date(this.#startedAt).toISOString(),
    };
  }

  /**
   * arms the next pass
   * @param wait milliseconds until it runs
   */
  #arm(wait: number): void {
    if (!this.#isStopped) {
      this.#timer = setTimeout(() => {
        void this.#pass();
      }, wait);
    }
  }

  /**
   * runs one pass under its deadline: a pass that outlasts it is logged and
   * left to end on its own, and the next pass is armed either way
   */
  async #pass(): Promise<void> {
    const { log, passDeadlineMs = PASS_DEADLINE_MS } = this.#params;
    if (this.#abandoned >= ABANDONED_LIMIT) {
      log.write({
        timer: 'pass',
        failure: `skipped: ${String(this.#abandoned)} abandoned passes are still running`,
      });
    } else {
      const work = this.#work();
      if (!(await settlesWithin(work, passDeadlineMs))) {
        this.#abandoned += 1;
        log.write({
          timer: 'pass',
          failure: `abandoned after ${String(passDeadlineMs)} ms`,
        });
        void work.finally(() => {
          this.#abandoned -= 1;
        });
      }
    }
    this.#arm(this.#params.intervalMs);
  }

  /**
   * does one pass's work: the update check, the governed tick unless an
   * update runs, and the log trim; a failure is logged and never thrown
   */
  async #work(): Promise<void> {
    try {
      await this.#startUpdate();
      if (await this.#isUpdateSettled()) {
        await this.#tick();
      }
      await this.#params.trim();
    } catch (error) {
      this.#params.log.write({
        timer: 'pass',
        failure: (error as Error).message,
      });
    }
  }

  /**
   * starts the shared update entry as root once the schedule is installed,
   * unless the last one still runs; the entry takes the update lock itself,
   * and its updater ends at once when no update is due
   */
  async #startUpdate(): Promise<void> {
    const { update, log } = this.#params;
    if (
      this.#update ||
      !(await lstat(update.readyFile).catch(() => undefined))
    ) {
      return;
    }
    try {
      for (const path of [SHELL, ...update.trusted]) {
        await this.#params.trust(path);
      }
    } catch (error) {
      log.write({ timer: 'update', refused: (error as Error).message });

      return;
    }
    const child = spawn(SHELL, ['-c', update.command], {
      cwd: '/',
      env: { ...update.environment },
      detached: true,
      stdio: 'ignore',
    });
    this.#update = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        this.#update = undefined;
        log.write({ timer: 'update', failure: error.message });
        resolve();
      });
      child.once('exit', (code, signal) => {
        this.#update = undefined;
        if (code !== 0) {
          log.write({
            timer: 'update',
            code: code ?? undefined,
            signal: signal ?? undefined,
          });
        }
        resolve();
      });
    });
  }

  /**
   * waits briefly for the update entry to end, so that a tick never enters an
   * idle form while an update runs: the updater takes its hold on the machine
   * only after it starts, and a tick between the two would let the machine
   * sleep under it
   * @returns whether no update entry runs now
   */
  async #isUpdateSettled(): Promise<boolean> {
    const { updateSettleMs = UPDATE_SETTLE_MS } = this.#params;
    if (this.#update) {
      await settlesWithin(this.#update, updateSettleMs);
    }

    return this.#update === undefined;
  }

  /**
   * runs one governed tick and records each new idle-form decision and each
   * change in the governor's notes; a decision recorded before the timer
   * started is the previous run's and is not repeated
   */
  async #tick(): Promise<void> {
    const { adapter, diagnostics } = await this.#params.tick();
    const { log } = this.#params;
    if (adapter && adapter.at !== this.#lastAdapterAt) {
      this.#lastAdapterAt = adapter.at;
      if (Date.parse(adapter.at) >= this.#startedAt) {
        log.write({
          governor: adapter.action,
          result: adapter.result,
          failure: adapter.failure,
          at: adapter.at,
        });
      }
    }
    const notes = diagnostics.join('; ');
    if (notes !== this.#lastNotes) {
      this.#lastNotes = notes;
      if (notes !== '') {
        log.write({ governor: 'notes', notes });
      }
    }
  }
}
