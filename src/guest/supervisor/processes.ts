import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { identifyProcess, isProcessGone } from '../idle/process-identity.js';

import { LOG_FILE_MODE } from './log.js';
import { LOGS_DIRECTORY, readChildren, writeChildren } from './store.js';

import type { ChildProcess } from 'node:child_process';

import type {
  AccountLaunch,
  RunningProcess,
  SupervisorParams,
} from './entries.js';
import type { SupervisedService } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code. The process
// mechanics under the supervisor: the trust check of a command line, a start
// in a process group of its own with its output in a root-only log, and the
// end of a group, asked first and then forced

/** how long a killed process group may take to end */
const KILL_WAIT_MS = 5_000;
const POLL_MS = 100;
const SERVICE_LOG_SUFFIX = '.log';
/** opens a service log for appending, never through a link */
const OUTPUT_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW;

/**
 * builds a service's command line behind its account's prefix; every
 * program root starts, and every absolute path a root service is given,
 * must be a file only root controls. A root service may not be given any other
 * argument that embeds a path (`--config=/x`, `./x`, `a/b`): only a whole
 * absolute path can be checked, so the rest is refused
 * @param params the accounts and the trust check
 * @param definition the service
 * @returns the program followed by its arguments
 * @throws {Error} when a root service has an argument that embeds a path
 */
export async function commandLine(
  params: Pick<SupervisorParams, 'accounts' | 'trust'>,
  definition: SupervisedService,
): Promise<string[]> {
  const { prefix } = params.accounts[definition.account];
  const rootArguments =
    definition.account === 'root' ? definition.arguments : [];
  const embedding = rootArguments.findIndex(isEmbeddedPath);
  if (embedding >= 0) {
    throw new Error(
      `${definition.name} runs as root, and its argument ${String(embedding + 1)} embeds a path that cannot be checked; pass a whole absolute path`,
    );
  }
  const rootPaths = [
    ...prefix.slice(0, 1),
    ...(definition.account === 'root'
      ? [
          definition.command,
          ...rootArguments.filter((argument) => argument.startsWith('/')),
        ]
      : []),
  ];
  for (const path of rootPaths) {
    await params.trust(path);
  }

  return [...prefix, definition.command, ...definition.arguments];
}

/**
 * names a service's output log
 * @param stateDirectory the persistent state directory
 * @param name service identifier
 * @returns absolute log path
 */
export function serviceLogPath(stateDirectory: string, name: string): string {
  return join(stateDirectory, LOGS_DIRECTORY, `${name}${SERVICE_LOG_SUFFIX}`);
}

/**
 * starts a program in a process group of its own as an account, its output
 * appended to a root-only log, or discarded when the log cannot be opened
 * @param argv the program followed by its arguments
 * @param launch the account's working directory and environment
 * @param outputPath absolute log path
 * @returns the child
 */
export function spawnInGroup(
  argv: readonly string[],
  launch: AccountLaunch,
  outputPath: string,
): ChildProcess {
  const [program = '', ...args] = argv;
  const output = openOutput(outputPath);
  try {
    return spawn(program, args, {
      cwd: launch.cwd,
      env: { ...launch.environment },
      detached: true,
      stdio: ['ignore', output, output],
    });
  } finally {
    if (typeof output === 'number') {
      closeSync(output);
    }
  }
}

/**
 * ends a process: its group is asked to end, then killed when it outlasts
 * the grace
 * @param running the child and its group
 * @param graceMs how long the group may take to end
 * @param onKill records the kill
 * @returns whether the process ended
 */
export async function endProcess(
  running: RunningProcess,
  graceMs: number,
  onKill: () => void,
): Promise<boolean> {
  running.isStopping = true;
  signalGroup(running.pid, 'SIGTERM');
  if (await settlesWithin(running.exited, graceMs)) {
    return true;
  }
  onKill();
  signalGroup(running.pid, 'SIGKILL');

  return settlesWithin(running.exited, KILL_WAIT_MS);
}

/**
 * ends every child the previous supervisor of this boot recorded and that
 * the process table still shows as the same process
 * @param params the run directory, the process table, the log and the clock
 */
export async function endLeftovers(
  params: Pick<SupervisorParams, 'runDirectory' | 'procRoot' | 'log' | 'now'>,
): Promise<void> {
  const { runDirectory, procRoot, log, now } = params;
  const { entries } = await readChildren(runDirectory);
  for (const child of entries) {
    const current = await identifyProcess(child.pid, procRoot);
    if (current?.start === child.start) {
      log.write({ service: child.name, event: 'leftover', pid: child.pid });
      signalGroup(child.pid, 'SIGTERM');
      const deadline = now() + KILL_WAIT_MS;
      while (!(await isProcessGone(child, procRoot)) && now() < deadline) {
        await delay(POLL_MS);
      }
      signalGroup(child.pid, 'SIGKILL');
    }
  }
  await writeChildren(runDirectory, []);
}

/**
 * sends a signal to a process group; a group that has already ended is no
 * failure
 * @param pid the group's leader, whose id is the group's
 * @param signal what to send, such as SIGTERM
 */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // the group has already ended
  }
}

/**
 * tells whether a promise settles within a time
 * @param promise the awaited work
 * @param ms how long to wait; a past deadline still sees a settled promise
 * @returns whether it settled in time
 */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  const timeout = new AbortController();

  return Promise.race([
    promise.then(() => true),
    delay(Math.max(0, ms), false, { signal: timeout.signal }).catch(
      () => false,
    ),
  ]).finally(() => {
    timeout.abort();
  });
}

/**
 * opens a service's output log for appending, never through a link
 * @param path absolute log path
 * @returns the descriptor, or `ignore` when the log cannot be opened
 */
function openOutput(path: string): number | 'ignore' {
  try {
    return openSync(path, OUTPUT_FLAGS, LOG_FILE_MODE);
  } catch {
    return 'ignore';
  }
}

/**
 * tells whether an argument carries a path that is not a whole absolute path:
 * a separator anywhere but a leading one, as in `--x=/path`, `./x` or `a/b`
 * @param argument one argument of a service
 * @returns whether the argument embeds a path
 */
function isEmbeddedPath(argument: string): boolean {
  return argument.includes('/') && !argument.startsWith('/');
}
