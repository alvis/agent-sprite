import { request } from 'node:http';

import { isRecord } from '../../../../guest/records.js';

import type { IncomingMessage } from 'node:http';

import type { IdleFormOutcome } from '../../../awake-adapters.js';

// Fly Machine awake adapter: puts the machine into its first available idle
// form through the guest-local Machines API socket, which only root reaches
// and which needs no token. The machine suspends from memory when it can and
// is stopped when it cannot or the suspend is refused. The socket accepts a
// suspend or stop of the machine itself but answers "unauthorized" to a read
// of it, and Fly accepts a suspend above 2 GB, so the memory comes from the
// environment the Fly init gives the guest. It runs as root, so it uses Node
// built-ins and relative imports only

/** guest-local Machines API socket */
const FLY_API_SOCKET = '/.fly/api';

/** the host name the Machines API expects on its local socket */
const API_HOST = 'flaps';

/**
 * longest an eligibility lookup lives; the governor waits 60 s for the whole
 * adapter call, which also covers one suspend and one stop request
 */
const INSPECT_TIMEOUT_MS = 5_000;

/** longest a suspend or stop request lives from start to end */
const ACTION_TIMEOUT_MS = 20_000;

/** most response bytes the adapter keeps for an error message */
const EXCERPT_BYTES = 256;

/** most response bytes of a machine description the adapter reads */
const MACHINE_BYTES = 262_144;

/** largest memory a suspended machine may have, in megabytes */
const SUSPEND_MEMORY_LIMIT_MB = 2_048;

const STATUS_OK_FIRST = 200;
const STATUS_OK_LAST = 299;

/** a Fly app name */
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** a Fly machine id */
const MACHINE_ID = /^[a-z0-9]{1,32}$/u;

/** the machine this guest runs on */
interface FlyMachineRef {
  /** app name */
  app: string;
  /** machine id */
  machine: string;
}

/** what one Machines API request answered */
interface FlyReply {
  /** HTTP status */
  status: number;
  /** leading part of the response body */
  body: string;
}

/**
 * reads the app and machine ids the Fly init gives every guest process
 * @returns the machine, or why the guest cannot name it
 */
function machineFromEnvironment(): FlyMachineRef | { failure: string } {
  const app = process.env.FLY_APP_NAME ?? '';
  const machine = process.env.FLY_MACHINE_ID ?? '';
  if (!APP_NAME.test(app) || !MACHINE_ID.test(machine)) {
    return {
      failure:
        'FLY_APP_NAME and FLY_MACHINE_ID are not set to a Fly app and machine, so the machine cannot name itself',
    };
  }

  return { app, machine };
}

/**
 * gathers the status and the start of the body of a response
 * @param response the Machines API's answer
 * @param params how much body to keep, and where the reply or failure goes
 * @param params.limit most body bytes kept
 * @param params.onReply receives the reply once the response has ended
 * @param params.onFailure receives the error of a response that broke
 */
function collectReply(
  response: IncomingMessage,
  params: {
    limit: number;
    onReply: (reply: FlyReply) => void;
    onFailure: (error: Error) => void;
  },
): void {
  const { limit, onReply, onFailure } = params;
  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer) => {
    if (size < limit) {
      chunks.push(chunk);
      size += chunk.length;
    }
  });
  response.on('error', onFailure);
  response.on('end', () => {
    onReply({
      status: response.statusCode ?? 0,
      body: Buffer.concat(chunks).subarray(0, limit).toString('utf8'),
    });
  });
}

/**
 * sends one request to the Machines API through the guest-local socket
 * @param ref app and machine
 * @param call what to send and how long to wait for it
 * @param call.method HTTP method
 * @param call.suffix path below the machine, empty for the machine itself
 * @param call.timeoutMs longest the request lives from start to end
 * @param call.limit most body bytes kept
 * @returns the status and the start of the body
 */
async function callApi(
  ref: FlyMachineRef,
  call: {
    method: 'GET' | 'POST';
    suffix: string;
    timeoutMs: number;
    limit: number;
  },
): Promise<FlyReply> {
  const { method, suffix, timeoutMs, limit } = call;

  return new Promise((resolve, reject) => {
    let reply: FlyReply | undefined;
    let failure: Error | undefined;
    const outgoing = request(
      {
        socketPath: FLY_API_SOCKET,
        path: `/v1/apps/${ref.app}/machines/${ref.machine}${suffix}`,
        method,
        headers: { host: API_HOST },
      },
      (response) => {
        collectReply(response, {
          limit,
          onReply: (value) => {
            reply = value;
          },
          onFailure: (error) => {
            failure = error;
          },
        });
      },
    );
    // one timer for the whole request, not an idle timer a server defeats by
    // sending a byte now and then
    const timer = setTimeout(() => {
      outgoing.destroy(
        new Error(`the Machines API did not answer within ${timeoutMs} ms`),
      );
    }, timeoutMs);
    outgoing.on('error', (error) => {
      failure = error;
    });
    outgoing.on('close', () => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
      } else if (reply) {
        resolve(reply);
      } else {
        reject(new Error('the Machines API closed without an answer'));
      }
    });
    outgoing.end();
  });
}

/**
 * tells whether the Machines API accepted a request
 * @param reply the API's answer
 * @returns true for any 2xx status
 */
function isAccepted(reply: FlyReply): boolean {
  return reply.status >= STATUS_OK_FIRST && reply.status <= STATUS_OK_LAST;
}

/**
 * describes a refusal for the failure record
 * @param action the request that was refused
 * @param reply the API's answer
 * @returns the status and the start of the body
 */
function refusal(action: string, reply: FlyReply): string {
  return `${action} answered ${reply.status}: ${reply.body.slice(0, EXCERPT_BYTES)}`;
}

/**
 * finds why the machine's configuration rules out a suspend: more than 2 GB
 * of memory, swap or a schedule. A description that cannot be read rules
 * nothing out, since the suspend request is then refused by the API itself
 * @param description the machine description as JSON
 * @returns the reason, or undefined when the machine may suspend
 */
function suspendBlocker(description: string): string | undefined {
  let machine: unknown;
  try {
    machine = JSON.parse(description);
  } catch {
    return undefined;
  }
  const config = isRecord(machine) ? machine.config : undefined;
  if (!isRecord(config)) {
    return undefined;
  }
  const memory = isRecord(config.guest) ? config.guest.memory_mb : undefined;
  if (typeof memory === 'number' && memory > SUSPEND_MEMORY_LIMIT_MB) {
    return memoryProblem(memory);
  }
  if (typeof config.swap_size_mb === 'number' && config.swap_size_mb > 0) {
    return 'the machine has swap configured, which a suspended machine cannot have';
  }
  if (typeof config.schedule === 'string' && config.schedule !== '') {
    return 'the machine has a schedule configured, which a suspended machine cannot have';
  }

  return undefined;
}

/**
 * describes a memory size a suspended machine cannot have
 * @param memory the machine's memory in megabytes
 * @returns the reason
 */
function memoryProblem(memory: number): string {
  return `the machine has ${memory} MB of memory, more than the ${SUSPEND_MEMORY_LIMIT_MB} MB a suspended machine may have`;
}

/**
 * reads the machine's memory from the environment the Fly init gives the guest
 * @returns the reason the memory rules out a suspend, or undefined when it
 * does not or is not known
 */
function environmentMemoryBlocker(): string | undefined {
  const memory = Number(process.env.FLY_VM_MEMORY_MB);

  return Number.isFinite(memory) && memory > SUSPEND_MEMORY_LIMIT_MB
    ? memoryProblem(memory)
    : undefined;
}

/**
 * finds out whether the machine may suspend, without failing the idle form.
 * The memory is known from the environment; the description the API gives
 * back, when it can be read, rules out swap and a schedule as well
 * @param ref app and machine
 * @returns the reason it may not, or undefined when it may or cannot be told
 */
async function ineligibility(ref: FlyMachineRef): Promise<string | undefined> {
  const memory = environmentMemoryBlocker();
  if (memory) {
    return memory;
  }
  const reply = await callApi(ref, {
    method: 'GET',
    suffix: '',
    timeoutMs: INSPECT_TIMEOUT_MS,
    limit: MACHINE_BYTES,
  }).catch(() => undefined);

  return reply && isAccepted(reply) ? suspendBlocker(reply.body) : undefined;
}

/**
 * stops the machine when a suspend was refused or is not possible
 * @param ref app and machine
 * @param suspendProblem why the machine did not suspend
 * @returns the stop, or the failure when the machine is still running
 */
async function stopInstead(
  ref: FlyMachineRef,
  suspendProblem: string,
): Promise<IdleFormOutcome> {
  try {
    const stop = await callApi(ref, {
      method: 'POST',
      suffix: '/stop',
      timeoutMs: ACTION_TIMEOUT_MS,
      limit: EXCERPT_BYTES,
    });

    return isAccepted(stop)
      ? { entered: 'stop' }
      : {
          failure: `the machine is still running: ${suspendProblem}; ${refusal('stop', stop)}`,
        };
  } catch (exception) {
    return {
      failure: `the machine is still running: ${suspendProblem}; the stop request failed: ${(exception as Error).message}`,
    };
  }
}

/**
 * suspends the machine from memory, or stops it when it is not suspend
 * eligible or the suspend is refused. A suspend request that ends without an
 * answer is not followed by a stop: the machine may be suspended already, and
 * stopping it after it resumed would undo the resume. It is reported as
 * unknown, not as a failure, and the governor decides from its boot clock
 * whether the machine resumed
 * @returns the idle form entered, or why none could be
 */
export async function enterIdleForm(): Promise<IdleFormOutcome> {
  const ref = machineFromEnvironment();
  if ('failure' in ref) {
    return ref;
  }
  const blocker = await ineligibility(ref);
  if (blocker) {
    return stopInstead(ref, blocker);
  }
  try {
    const suspend = await callApi(ref, {
      method: 'POST',
      suffix: '/suspend',
      timeoutMs: ACTION_TIMEOUT_MS,
      limit: EXCERPT_BYTES,
    });

    return isAccepted(suspend)
      ? { entered: 'memory-suspend' }
      : await stopInstead(ref, refusal('suspend', suspend));
  } catch (exception) {
    // a snapshot taken mid-request can reset the connection on resume, so no
    // answer does not mean the suspend failed
    return {
      unknown: `the suspend request ended without an answer, so the machine may have been suspended and resumed: ${(exception as Error).message}`,
    };
  }
}
