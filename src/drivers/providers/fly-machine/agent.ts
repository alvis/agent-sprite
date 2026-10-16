import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';

import { FLYCTL, flyctlEnvironment, prepareFlyctlDirectory } from './flyctl';

const STOP_TIMEOUT_MS = 30_000;
/** the directory naming, one file a pid, every process with an open session */
const SESSIONS_DIRECTORY = 'sessions';
/** the directory whose creation is the lock over the registry and the agent */
const LOCK_DIRECTORY = 'agent.lock';
const LOCK_POLL_MS = 100;
/** a lock older than any stop it guards was left by a process that died holding it */
const STALE_LOCK_MS = 120_000;
const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * `fly ssh console` has no in-process mode: it always reaches the guest
 * through flyctl's background agent, starting one when none answers on the
 * configuration directory's socket, and that agent inherits the derived SSH
 * token and outlives the session that started it (flyctl 0.4.108:
 * internal/command/ssh/console.go calls agent.BringUpAgentOrgSlug, whose
 * agent/client.go Establish runs agent/start.go StartDaemon, forking
 * `fly agent run` with the caller's environment and no idle timeout). Every
 * open-agent process shares the configuration directory, and so the agent,
 * whose stop ends every session through it; each process therefore counts
 * its open sessions and names itself in a registry beside the configuration
 * while it has any, and the process whose last session ends stops the agent
 * only when no other live process remains named, under a lock that keeps
 * another process from starting a session during the stop
 */
class FlyctlAgentSessions {
  #open = 0;
  #changing: Promise<void> | undefined;

  /**
   * runs one SSH session, stopping the private agent once no session of any
   * open-agent process remains
   * @param session starts the session and settles when it has ended
   * @returns what the session returned
   */
  public async hold<T>(session: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await session();
    } finally {
      await this.#release();
    }
  }

  /**
   * counts a new session once no change of the registry is under way, naming
   * this process in the registry for its first
   * @returns resolves once the session is counted
   */
  async #acquire(): Promise<void> {
    const changing = this.#changing;
    if (changing) {
      await changing;

      return this.#acquire();
    }
    this.#open += 1;
    if (this.#open === 1) {
      try {
        await this.#change(async () => withAgentLock(registerProcess));
      } catch (error) {
        this.#open -= 1;
        throw error;
      }
    }
  }

  /**
   * counts an ended session and, after the last one, removes this process
   * from the registry and stops the agent unless another process holds it
   * @returns resolves once a stop it started has finished
   */
  async #release(): Promise<void> {
    this.#open -= 1;
    if (this.#open > 0) {
      return;
    }
    await this.#change(async () => withAgentLock(releaseProcess));
  }

  /**
   * runs a registry change that sessions of this process wait for
   * @param change registers or releases this process under the lock
   * @returns resolves once the change has finished
   */
  async #change(change: () => Promise<void>): Promise<void> {
    const changing = change().finally(() => {
      this.#changing = undefined;
    });
    this.#changing = changing;
    await changing;
  }
}

/** the SSH sessions this process holds through the private flyctl agent */
export const flyctlAgent = new FlyctlAgentSessions();

/**
 * runs a step while holding the lock over the registry and the agent, taking
 * over a lock a dead process left
 * @param step what to run under the lock, given the private flyctl configuration directory
 * @returns resolves once the step has run and the lock is released
 */
async function withAgentLock(
  step: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await prepareFlyctlDirectory();
  const lock = join(directory, LOCK_DIRECTORY);
  while (!(await tryLock(lock))) {
    await delay(LOCK_POLL_MS);
  }
  try {
    await step(directory);
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

/**
 * takes the lock once, removing it first when a dead process left it
 * @param lock the lock directory
 * @returns whether the lock is now held
 */
async function tryLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock, { mode: PRIVATE_DIRECTORY_MODE });

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const held = await stat(lock).catch(() => undefined);
  if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
    await rmdir(lock).catch(() => undefined);
  }

  return false;
}

/**
 * names this process in the registry
 * @param directory the private flyctl configuration directory
 */
async function registerProcess(directory: string): Promise<void> {
  const sessions = join(directory, SESSIONS_DIRECTORY);
  await mkdir(sessions, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await writeFile(join(sessions, String(process.pid)), '');
}

/**
 * removes this process and every dead one from the registry, then stops the
 * agent when no live process remains named
 * @param directory the private flyctl configuration directory
 */
async function releaseProcess(directory: string): Promise<void> {
  const sessions = join(directory, SESSIONS_DIRECTORY);
  await rm(join(sessions, String(process.pid)), { force: true });
  const named = await readdir(sessions).catch(() => []);
  const live = named.filter((name) => isLive(Number(name)));
  for (const name of named.filter((entry) => !live.includes(entry))) {
    await rm(join(sessions, name), { force: true });
  }
  if (live.length === 0) {
    await stopAgent();
  }
}

/**
 * tells whether a process still runs
 * @param pid process id
 * @returns false for a process that has exited or an unreadable name
 */
function isLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // a process of another account still runs
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * stops the agent of the private configuration directory; `fly agent stop`
 * needs no token and fails harmlessly when no agent is running, and it runs
 * even after the operation was cancelled, because the agent holds a token
 */
async function stopAgent(): Promise<void> {
  await execa(FLYCTL, ['agent', 'stop'], {
    env: flyctlEnvironment(),
    extendEnv: false,
    stdin: 'ignore',
    timeout: STOP_TIMEOUT_MS,
    reject: false,
  });
}
