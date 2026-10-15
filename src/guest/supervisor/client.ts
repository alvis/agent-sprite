import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { CONTROL_LINE_LIMIT_BYTES, isControlResponse } from './protocol.js';

import type { ControlRequest, ControlResponse } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code. The control
// entry's side of the socket: it waits a bounded time for the supervisor,
// which the provider's init starts a few seconds after the host installs it,
// sends one request and reads one answer

/** how often a connection that found no supervisor is tried again */
const RETRY_MS = 250;
const UNAVAILABLE: ControlResponse = {
  ok: false,
  code: 'unavailable',
  error: 'The guest supervisor is not running',
};
const MALFORMED: ControlResponse = {
  ok: false,
  code: 'failed',
  error: 'The guest supervisor gave no valid answer',
};

/**
 * sends one request to the supervisor and reads its answer
 * @param path absolute socket path
 * @param request the validated control request
 * @param waitMs how long to wait for the supervisor to listen
 * @returns the supervisor's answer, or why there is none
 */
export async function requestSupervisor(
  path: string,
  request: ControlRequest,
  waitMs: number,
): Promise<ControlResponse> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const outcome = await exchange(path, `${JSON.stringify(request)}\n`);
    if (outcome !== 'absent') {
      return outcome;
    }
    if (Date.now() >= deadline) {
      return UNAVAILABLE;
    }
    await delay(RETRY_MS);
  }
}

/**
 * writes a request line and reads the answer line
 * @param path absolute socket path
 * @param line the request line
 * @returns the answer, or `absent` when no supervisor listens yet
 */
async function exchange(
  path: string,
  line: string,
): Promise<ControlResponse | 'absent'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let isConnected = false;
    const socket = connect(path, () => {
      isConnected = true;
      socket.write(line);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received > CONTROL_LINE_LIMIT_BYTES) {
        socket.destroy();
      }
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(isConnected ? MALFORMED : 'absent');
    });
    socket.on('close', () => {
      resolve(decode(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

/**
 * decodes the answer line
 * @param text everything the supervisor wrote
 * @returns the validated answer, or a failure naming its absence
 */
function decode(text: string): ControlResponse {
  try {
    const decoded: unknown = JSON.parse(text.split('\n', 1)[0] ?? '');

    return isControlResponse(decoded) ? decoded : MALFORMED;
  } catch {
    return MALFORMED;
  }
}
