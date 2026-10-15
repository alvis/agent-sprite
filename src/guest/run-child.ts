import { spawn } from 'node:child_process';

import type { ChildProcess, StdioOptions } from 'node:child_process';

// guest kernel: imports only Node built-ins. A managed operation that keeps
// the workstation awake refreshes its hold on a timer, so every child it runs
// must be waited for without blocking the event loop

// a child is asked to stop this long before its limit, so a wrapper such as
// runuser can pass the request on to the program it runs, which SIGKILL cannot
const TERMINATE_GRACE_MS = 5_000;

// the children still running, each leading a process group of its own, and
// so without the caller's terminal. A process asked to stop, interrupted or
// hung up passes the signal on to every program they started, so none
// outlives it holding a lock, then ends as the signal would have ended it
const running = new Set<ChildProcess>();

/**
 * sends a signal to everything a child started, ignoring a group that has
 * already ended
 * @param child a child started by `runChild`
 * @param signal the signal to send
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group has already ended
  }
}

/**
 * passes a signal on to every child still running, then lets it end this
 * process as it would have, unless the process handles it itself
 * @param signal the signal this process received
 */
function forward(signal: NodeJS.Signals): void {
  for (const child of running) {
    signalGroup(child, signal);
  }
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

const forwarders = new Map(
  (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map((signal) => [
    signal,
    () => forward(signal),
  ]),
);

/**
 * tracks a child until it ends, passing on the signals that end a process
 * meanwhile
 * @param child the child just started
 */
function track(child: ChildProcess): void {
  if (running.size === 0) {
    for (const [signal, forwarder] of forwarders) {
      process.once(signal, forwarder);
    }
  }
  running.add(child);
}

/**
 * stops tracking a child that ended
 * @param child a child that has ended or failed to start
 */
function untrack(child: ChildProcess): void {
  running.delete(child);
  if (running.size === 0) {
    for (const [signal, forwarder] of forwarders) {
      process.off(signal, forwarder);
    }
  }
}

/** how a child is run */
export interface ChildOptions {
  /** the child's whole environment */
  env: NodeJS.ProcessEnv;
  /** longest the child may run: its process group is sent SIGTERM shortly before, and SIGKILL at the limit */
  timeoutMs: number;
  /** the child's descriptors; its output is captured when descriptor 1 is a pipe */
  stdio?: StdioOptions;
  /** the child's working directory; the caller's by default */
  cwd?: string;
}

/** a failed child, carrying the exit status the way a synchronous run did */
export interface ChildFailure extends Error {
  /** exit status; absent when the child did not exit by itself */
  status?: number;
}

/**
 * runs a child to its end without blocking the event loop
 * @param file absolute path of the program
 * @param args program arguments
 * @param options environment, time limit and descriptors
 * @returns the child's captured standard output, empty when none is captured
 * @throws {ChildFailure} when the child cannot start, exits non-zero or is
 * ended at its time limit
 */
export async function runChild(
  file: string,
  args: readonly string[],
  options: ChildOptions,
): Promise<string> {
  const {
    env,
    timeoutMs,
    stdio = ['ignore', 'pipe', 'inherit'],
    cwd,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio,
      // a group of its own, so a signal reaches every program the child starts
      detached: true,
    });
    const asked = setTimeout(
      () => signalGroup(child, 'SIGTERM'),
      Math.max(timeoutMs - TERMINATE_GRACE_MS, timeoutMs / 2),
    );
    const killed = setTimeout(() => signalGroup(child, 'SIGKILL'), timeoutMs);
    track(child);
    const settle = (): void => {
      clearTimeout(asked);
      clearTimeout(killed);
      untrack(child);
    };
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error) => {
      settle();
      reject(error);
    });
    child.on('close', (code, signal) => {
      settle();
      if (code === 0) {
        resolve(output);

        return;
      }
      const failure: ChildFailure = new Error(
        signal === null
          ? `${file} exited with status ${code}`
          : `${file} was ended by ${signal}`,
      );
      if (code !== null) {
        failure.status = code;
      }
      reject(failure);
    });
  });
}
