import { AGENT_HOME } from '../guest-root.js';

import { SupervisorFault } from './fault.js';

import type { HolderProcess } from '../idle/process-identity.js';

import type { SupervisorLog } from './log.js';
import type {
  ServiceAccount,
  SupervisedService,
  SupervisedServiceState,
} from './protocol.js';
import type { DesiredStatus } from './store.js';

// guest kernel: imports only Node built-ins and other guest code. The model
// the supervisor keeps for each registered service: its definition, whether
// it should run, its current process and its pending restart

/** the first delay before a service that exited is started again */
export const RESTART_INITIAL_MS = 1_000;
/** the longest delay before a service that keeps exiting is started again */
export const RESTART_MAX_MS = 60_000;

/** how one account's services are started */
export interface AccountLaunch {
  /** program and arguments placed before the service's command, such as the switch to the account; the first is checked like a root command */
  prefix: readonly string[];
  /** working directory */
  cwd: string;
  /** the complete environment the service starts with */
  environment: Readonly<Record<string, string>>;
}

/** what the supervisor needs from the guest it runs on */
export interface SupervisorParams {
  /** the persistent state directory holding the desired services and the service logs */
  stateDirectory: string;
  /** this boot's run directory holding the running children's record */
  runDirectory: string;
  /** how each account's services are started */
  accounts: Readonly<Record<ServiceAccount, AccountLaunch>>;
  /** where the supervisor records what it did */
  log: SupervisorLog;
  /** where the process table is; `/proc` when absent */
  procRoot?: string;
  /** current epoch milliseconds */
  now: () => number;
  /** resolves a path root runs to a file only root controls, or throws */
  trust: (path: string) => Promise<string>;
}

/** one process a service runs */
export interface RunningProcess {
  /** process id, which is also its process group id; 0 when the spawn failed */
  pid: number;
  /** epoch milliseconds the process started */
  startedAt: number;
  /** settles once the process has ended */
  exited: Promise<void>;
  /** whether the supervisor is ending it */
  isStopping: boolean;
  /** the process's identity in the process table, once read */
  identity?: HolderProcess;
}

/** when a process that ended on its own ran */
export interface ProcessSpan {
  /** epoch milliseconds the process started */
  startedAt: number;
  /** epoch milliseconds the process ended */
  endedAt: number;
}

/** one registered service and its process */
export interface ServiceEntry {
  /** the registered definition */
  definition: SupervisedService;
  /** whether the supervisor keeps it running */
  desired: DesiredStatus;
  /** consecutive starts that ended early or were refused */
  failures: number;
  /** whether a start is waiting for its command's trust check */
  isLaunching: boolean;
  /** whether a replacement keeps it stopped for now */
  isHeld: boolean;
  /** the current process */
  running?: RunningProcess;
  /** the last process that ended without the supervisor ending it */
  lastExit?: ProcessSpan;
  /** the pending restart */
  restart?: NodeJS.Timeout;
  /** how the last process ended, or why the last start was refused */
  lastOutcome?: string;
}

/** how a process ended */
export interface ProcessExit {
  /** exit code */
  code: number | null;
  /** terminating signal */
  signal: NodeJS.Signals | null;
  /** why the process could not be started */
  error?: Error;
}

/** the search path every service and update check starts with */
export const SERVICE_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** the locale every service starts with */
export const SERVICE_LOCALE = 'C.UTF-8';

/** the complete environment of a service that runs as root */
export const ROOT_ENVIRONMENT = {
  PATH: SERVICE_PATH,
  HOME: '/root',
  USER: 'root',
  LOGNAME: 'root',
  LANG: SERVICE_LOCALE,
};

/** the complete environment of a service that runs as the agent account */
export const AGENT_ENVIRONMENT = {
  PATH: SERVICE_PATH,
  HOME: AGENT_HOME,
  USER: 'agent',
  LOGNAME: 'agent',
  LANG: SERVICE_LOCALE,
};

/**
 * switches a root-started command to the agent account without leaving a
 * parent behind: `setpriv` replaces itself with the program, so the
 * supervisor's process group holds the service alone and the supervisor's own
 * grace decides how long the service has to end (`runuser` stays as a parent
 * that kills the service 2 seconds after a SIGTERM). `--reset-env` drops
 * everything the supervisor held and `env` then states the service's
 * environment outright, so nothing reaches it by accident
 */
export const AGENT_PREFIX = [
  '/usr/bin/setpriv',
  '--reuid=agent',
  '--regid=agent',
  '--init-groups',
  '--reset-env',
  '--',
  '/usr/bin/env',
  ...Object.entries(AGENT_ENVIRONMENT).map(
    ([name, value]) => `${name}=${value}`,
  ),
] as const;

/** how the supervisor starts a service as each account */
export const GUEST_ACCOUNTS: Readonly<Record<ServiceAccount, AccountLaunch>> = {
  root: { prefix: [], cwd: '/', environment: ROOT_ENVIRONMENT },
  agent: {
    prefix: AGENT_PREFIX,
    cwd: AGENT_HOME,
    environment: AGENT_ENVIRONMENT,
  },
};

/**
 * creates the entry of a service that is not running yet
 * @param definition the registered definition
 * @param desired whether the supervisor keeps it running
 * @returns an entry with no process and no failures
 */
export function newEntry(
  definition: SupervisedService,
  desired: DesiredStatus,
): ServiceEntry {
  return {
    definition,
    desired,
    failures: 0,
    isLaunching: false,
    isHeld: false,
  };
}

/**
 * reports a service's state from its process and what it should be
 * @param entry the service
 * @returns the status the service contract reports
 */
export function statusOf(
  entry: ServiceEntry,
): SupervisedServiceState['status'] {
  if (entry.running) {
    return entry.running.isStopping ? 'stopping' : 'running';
  }
  if (entry.desired === 'stopped' || entry.isHeld) {
    return 'stopped';
  }

  return entry.restart === undefined ? 'starting' : 'failed';
}

/**
 * cancels a service's pending restart
 * @param entry the service
 */
export function clearRestart(entry: ServiceEntry): void {
  if (entry.restart !== undefined) {
    clearTimeout(entry.restart);
    entry.restart = undefined;
  }
}

/**
 * computes the delay before a restart, doubling with each failure in a row
 * up to its limit
 * @param failures consecutive failures, this one included
 * @returns the delay in milliseconds
 */
export function restartDelay(failures: number): number {
  return Math.min(RESTART_MAX_MS, RESTART_INITIAL_MS * 2 ** (failures - 1));
}

/**
 * refuses a definition that needs a service the supervisor cannot run
 * first: one not registered, one kept stopped, or one that needs it back
 * @param entries the registered services
 * @param definition the desired service
 * @throws {SupervisorFault} naming the need
 */
export function checkNeeds(
  entries: ReadonlyMap<string, ServiceEntry>,
  definition: SupervisedService,
): void {
  for (const need of definition.needs) {
    const entry = entries.get(need);
    if (!entry) {
      throw new SupervisorFault(
        'conflict',
        `${definition.name} needs ${need}, which is not registered`,
      );
    }
    if (entry.desired === 'stopped') {
      throw new SupervisorFault(
        'conflict',
        `${definition.name} needs ${need}, which is stopped`,
      );
    }
  }
  const visited = new Set<string>();
  const pending = [...definition.needs];
  for (let need = pending.pop(); need !== undefined; need = pending.pop()) {
    if (need === definition.name) {
      throw new SupervisorFault(
        'conflict',
        `${definition.name} would need itself through its needs`,
      );
    }
    if (!visited.has(need)) {
      visited.add(need);
      pending.push(...(entries.get(need)?.definition.needs ?? []));
    }
  }
}

/**
 * describes how a process ended
 * @param exit how it ended
 * @returns non-secret outcome
 */
export function describeExit(exit: ProcessExit): string {
  if (exit.error) {
    return `not started: ${exit.error.message}`;
  }

  return exit.signal
    ? `signal ${exit.signal}`
    : `exit code ${String(exit.code)}`;
}
