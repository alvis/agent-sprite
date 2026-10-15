import { execa } from 'execa';

import { FLYCTL, flyctlEnvironment } from './flyctl.js';

const STOP_TIMEOUT_MS = 30_000;

/**
 * `fly ssh console` has no in-process mode: it always reaches the guest
 * through flyctl's background agent, starting one when none answers on the
 * configuration directory's socket, and that agent inherits the derived SSH
 * token and outlives the session that started it (flyctl 0.4.108:
 * internal/command/ssh/console.go calls agent.BringUpAgentOrgSlug, whose
 * agent/client.go Establish runs agent/start.go StartDaemon, forking
 * `fly agent run` with the caller's environment and no idle timeout). This
 * process therefore counts its open sessions and stops the private agent
 * when the last one ends, before a new session may start another
 */
class FlyctlAgentSessions {
  #open = 0;
  #stopping: Promise<void> | undefined;

  /**
   * runs one SSH session, stopping the private agent once no session of this
   * process remains
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
   * counts a new session once no stop of the agent is under way
   * @returns resolves once the session is counted
   */
  async #acquire(): Promise<void> {
    const stopping = this.#stopping;
    if (stopping) {
      await stopping;

      return this.#acquire();
    }
    this.#open += 1;
  }

  /**
   * counts an ended session and stops the agent after the last one
   * @returns resolves once a stop it started has finished
   */
  async #release(): Promise<void> {
    this.#open -= 1;
    if (this.#open > 0) {
      return;
    }
    const stopping = stopAgent().finally(() => {
      this.#stopping = undefined;
    });
    this.#stopping = stopping;
    await stopping;
  }
}

/** the SSH sessions this process holds through the private flyctl agent */
export const flyctlAgent = new FlyctlAgentSessions();

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
