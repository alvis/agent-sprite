import { join } from 'node:path';

import { requestSupervisor } from './client.js';
import {
  CONTROL_LINE_LIMIT_BYTES,
  CONTROL_SOCKET_NAME,
  SUPERVISOR_RUN_DIRECTORY,
  isControlRequest,
} from './protocol.js';

import type { ControlResponse } from './protocol.js';

// guest kernel: the control entry the host runs as root through the guest
// channel, as `node control.js <list|ensure|stop|remove> [name]`, with an
// ensured definition as JSON on standard input; imports only Node built-ins
// and other guest code. It prints the supervisor's one-line answer and exits
// non-zero when the answer is a refusal

/** how long the entry waits for a supervisor the init is still starting */
const SUPERVISOR_WAIT_MS = 20_000;
const FAILURE_STATUS = 1;

const response = await respond(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(response)}\n`);
process.exitCode = response.ok ? 0 : FAILURE_STATUS;

/**
 * builds the request the arguments name and sends it
 * @param args the action, then the service identifier for stop and remove
 * @returns the supervisor's answer, or why the request is not valid
 */
async function respond(args: readonly string[]): Promise<ControlResponse> {
  const [action, name] = args;
  const request =
    action === 'ensure'
      ? { action, definition: await readDefinition() }
      : action === 'list'
        ? { action }
        : { action, name };
  if (!isControlRequest(request)) {
    return { ok: false, code: 'invalid', error: 'The request is not valid' };
  }

  return requestSupervisor(
    join(SUPERVISOR_RUN_DIRECTORY, CONTROL_SOCKET_NAME),
    request,
    SUPERVISOR_WAIT_MS,
  );
}

/**
 * reads the definition from standard input, bounded to one control line
 * @returns the decoded definition, or undefined when it is not JSON or too long
 */
async function readDefinition(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    received += chunk.length;
    if (received > CONTROL_LINE_LIMIT_BYTES) {
      return undefined;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
