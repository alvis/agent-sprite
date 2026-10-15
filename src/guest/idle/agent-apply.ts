import { spawn } from 'node:child_process';

import { AGENT_HOME } from '../guest-root.js';

import { TERMINATE_GRACE_MS } from './dispatch.js';
import { isAdapterResult } from './state.js';

import type { AdapterResult } from './state.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. A `native-deadline` adapter only ever runs as the agent account,
// so a root caller never imports it: it starts the root-owned apply entry as a
// child running with the agent account's user and group, with no arguments, no
// input and an environment of its own, and reads back only the validated
// result the child prints

/** largest result the apply entry prints, in bytes */
const RESULT_MAX_BYTES = 4_096;
const CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';

/** the account a `native-deadline` adapter runs as */
export interface AgentAccount {
  /** the agent account's user id */
  uid: number;
  /** the agent account's group id */
  gid: number;
}

/** how a root caller hands the apply to the agent account */
export interface AgentApply {
  /** absolute path of the root-owned apply entry */
  entry: string;
  /** the agent account; undefined when it could not be found */
  account: AgentAccount | undefined;
  /** longest the child may run before it is ended */
  limitMs: number;
  /** ISO 8601 instant a failure is recorded at */
  at: string;
}

/**
 * applies the latest deadline in a child running as the agent account
 * @param params the apply entry, the agent account, the time limit and the
 * instant of the call
 * @returns the child's validated result, or the failure that stopped it
 */
export async function applyAsAgentAccount(
  params: AgentApply,
): Promise<AdapterResult> {
  const { entry, account, limitMs, at } = params;
  const failed = (failure: string): AdapterResult => ({
    at,
    action: 'apply-deadline',
    failure,
  });
  if (!account) {
    return failed('the agent account is unknown, so no deadline was applied');
  }
  if (account.uid === 0) {
    return failed('a native-deadline adapter never runs as root');
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      uid: account.uid,
      gid: account.gid,
      cwd: '/',
      env: { HOME: AGENT_HOME, PATH: CHILD_PATH },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // SIGTERM first, so the child releases the apply lock it holds; SIGKILL
    // only at the limit, for a child that did not stop
    const asked = setTimeout(
      () => {
        child.kill('SIGTERM');
      },
      Math.max(limitMs - TERMINATE_GRACE_MS, limitMs / 2),
    );
    const killed = setTimeout(() => {
      child.kill('SIGKILL');
    }, limitMs);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output = `${output}${chunk}`.slice(0, RESULT_MAX_BYTES + 1);
    });
    child.on('error', () => {
      clearTimeout(asked);
      clearTimeout(killed);
      resolve(failed('the agent-account apply could not start'));
    });
    child.on('close', (code) => {
      clearTimeout(asked);
      clearTimeout(killed);
      // a child that stopped on SIGTERM may still have printed its result
      resolve(
        resultOf(output) ??
          failed(
            code === null
              ? `the agent-account apply did not finish within ${limitMs} ms`
              : 'the agent-account apply returned no result',
          ),
      );
    });
  });
}

/**
 * reads the result the apply entry printed
 * @param output the child's standard output
 * @returns the validated result, or undefined when there is none
 */
function resultOf(output: string): AdapterResult | undefined {
  if (output.length > RESULT_MAX_BYTES) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(output);

    return isAdapterResult(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
