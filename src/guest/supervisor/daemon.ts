import { join } from 'node:path';

import { SupervisorFault } from './fault.js';
import { fileLog, trimLog } from './log.js';
import { CONTROL_SOCKET_NAME, MAINTENANCE_TIMER } from './protocol.js';
import { serveControl } from './server.js';
import { LOGS_DIRECTORY, preparePrivateDirectory } from './store.js';
import { Supervisor } from './supervisor.js';
import { MaintenanceTimer } from './timer.js';

import type { Server } from 'node:net';

import type { GovernorState } from '../idle/state.js';

import type { AccountLaunch } from './entries.js';
import type { LogFields, SupervisorLog } from './log.js';
import type {
  ControlRequest,
  ControlResponse,
  ServiceAccount,
} from './protocol.js';
import type { UpdateSchedule } from './timer.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The daemon joins the supervisor, its maintenance timer and its
// control socket over one set of directories, so the deployed entry and the
// packaged checks run the same code against a different guest root

/** what the daemon runs over */
export interface DaemonParams {
  /** the persistent state directory: the desired services and the service logs */
  stateDirectory: string;
  /** this boot's run directory: the control socket and the running children */
  runDirectory: string;
  /** the supervisor's own log */
  logPath: string;
  /** how each account's services are started */
  accounts: Readonly<Record<ServiceAccount, AccountLaunch>>;
  /** milliseconds between timer passes */
  timerIntervalMs: number;
  /** the update schedule the timer runs */
  update: UpdateSchedule;
  /** where the process table is; `/proc` when absent */
  procRoot?: string;
  /** current epoch milliseconds */
  now: () => number;
  /** resolves a path root runs to a file only root controls, or throws */
  trust: (path: string) => Promise<string>;
  /** runs one governed tick */
  tick: () => Promise<GovernorState>;
  /** writes each log line to the console as well, when given */
  echo?: (line: string) => void;
}

/** a running daemon */
export interface RunningDaemon {
  /** writes one record to the supervisor's log */
  log: (fields: LogFields) => void;
  /** stops serving and the timer, then ends every service */
  stop: () => Promise<void>;
}

/**
 * prepares the directories, restores the recorded services, then serves the
 * control socket and starts the timer
 * @param params directories, accounts, timer, update schedule and governor
 * @returns the running daemon
 */
export async function runDaemon(params: DaemonParams): Promise<RunningDaemon> {
  const { stateDirectory, runDirectory } = params;
  const log = fileLog({
    path: params.logPath,
    now: params.now,
    echo: params.echo,
  });
  await preparePrivateDirectory(stateDirectory);
  await preparePrivateDirectory(join(stateDirectory, LOGS_DIRECTORY));
  await preparePrivateDirectory(runDirectory);
  const supervisor = new Supervisor({ ...params, log });
  await supervisor.start();
  const timer = new MaintenanceTimer({
    ...params,
    intervalMs: params.timerIntervalMs,
    log,
    trim: async () => {
      for (const path of [params.logPath, ...supervisor.logPaths()]) {
        await trimLog(path);
      }
    },
  });
  const server = await serveRequests(join(runDirectory, CONTROL_SOCKET_NAME), {
    supervisor,
    timer,
    log,
  });
  timer.start();

  return {
    log: (fields) => {
      log.write(fields);
    },
    stop: async () => {
      timer.stop();
      server.close();
      await supervisor.shutdown();
    },
  };
}

/** what serves the control requests */
interface RequestTargets {
  /** the services */
  supervisor: Supervisor;
  /** the maintenance timer, listed beside the services */
  timer: MaintenanceTimer;
  /** where failed requests are recorded */
  log: SupervisorLog;
}

/**
 * serves the control socket
 * @param path absolute socket path
 * @param targets the supervisor, the timer and the log
 * @returns the listening server
 */
async function serveRequests(
  path: string,
  targets: RequestTargets,
): Promise<Server> {
  return serveControl(path, async (request) => {
    try {
      return await carryOut(request, targets);
    } catch (error) {
      const { code, message } =
        error instanceof SupervisorFault
          ? error
          : { code: 'failed' as const, message: (error as Error).message };
      targets.log.write({
        control: request.action,
        name: requestedName(request),
        failure: message,
      });

      return { ok: false, code, error: message };
    }
  });
}

/**
 * carries out one request
 * @param request the validated request
 * @param targets the supervisor and the timer
 * @returns the answer
 * @throws {SupervisorFault} when the supervisor refuses the request
 */
async function carryOut(
  request: ControlRequest,
  targets: RequestTargets,
): Promise<ControlResponse> {
  const { supervisor, timer } = targets;
  if (request.action === 'list') {
    return { ok: true, services: [...supervisor.list(), timer.state()] };
  }
  if (request.action === 'ensure') {
    await supervisor.ensure(request.definition);

    return { ok: true };
  }
  if (request.name === MAINTENANCE_TIMER) {
    throw new SupervisorFault(
      'invalid',
      'The maintenance timer is part of the supervisor',
    );
  }
  if (request.action === 'stop') {
    return { ok: true, stopped: await supervisor.stop(request.name) };
  }
  await supervisor.remove(request.name);

  return { ok: true };
}

/**
 * names the service a request is about
 * @param request the validated request
 * @returns the service identifier, or undefined for a list
 */
function requestedName(request: ControlRequest): string | undefined {
  switch (request.action) {
    case 'list':
      return undefined;
    case 'ensure':
      return request.definition.name;
    default:
      return request.name;
  }
}
