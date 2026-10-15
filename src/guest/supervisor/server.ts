import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';

import { CONTROL_LINE_LIMIT_BYTES, isControlRequest } from './protocol.js';

import type { Server, Socket } from 'node:net';

import type { ControlRequest, ControlResponse } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code. The control
// socket sits in the supervisor's root-only run directory, and is itself
// root's alone, so only root, which the host's control entry runs as, can
// reach it. Each connection carries one request line and gets one answer line

/** mode of the control socket: root alone connects */
const SOCKET_MODE = 0o600;
/** how long a connection may take to send its request */
const REQUEST_TIMEOUT_MS = 10_000;

/** answers one validated request */
export type ControlHandler = (
  request: ControlRequest,
) => Promise<ControlResponse>;

/**
 * listens on the control socket, replacing a socket an earlier supervisor of
 * this boot left behind
 * @param path absolute socket path
 * @param handle answers each validated request
 * @returns the listening server
 * @throws {Error} when something other than a socket holds the path
 */
export async function serveControl(
  path: string,
  handle: ControlHandler,
): Promise<Server> {
  const existing = await lstat(path).catch(() => undefined);
  if (existing && !existing.isSocket()) {
    throw new Error(`${path} is not the supervisor's socket`);
  }
  if (existing) {
    await unlink(path);
  }
  const server = createServer((socket) => {
    serveConnection(socket, handle);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, SOCKET_MODE);

  return server;
}

/**
 * reads one request line from a connection and writes its answer
 * @param socket an accepted client socket
 * @param handle answers the validated request
 */
function serveConnection(socket: Socket, handle: ControlHandler): void {
  const chunks: Buffer[] = [];
  let received = 0;
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
    socket.destroy();
  });
  socket.on('error', () => {
    socket.destroy();
  });
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    received += chunk.length;
    const text = Buffer.concat(chunks).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0 && received <= CONTROL_LINE_LIMIT_BYTES) {
      return;
    }
    socket.off('data', onData);
    socket.setTimeout(0);
    void answer(end < 0 ? undefined : text.slice(0, end), handle).then(
      (response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      },
    );
  };
  socket.on('data', onData);
}

/**
 * decodes and answers one request line
 * @param line the request line, or undefined when it outgrew the limit
 * @param handle answers the validated request
 * @returns the response to write back
 */
async function answer(
  line: string | undefined,
  handle: ControlHandler,
): Promise<ControlResponse> {
  const request = parse(line);
  if (!isControlRequest(request)) {
    return { ok: false, code: 'invalid', error: 'The request is not valid' };
  }

  return handle(request);
}

/**
 * decodes a request line
 * @param line the line, if any
 * @returns the decoded value, or undefined when it is not JSON
 */
function parse(line: string | undefined): unknown {
  try {
    return line === undefined ? undefined : JSON.parse(line);
  } catch {
    return undefined;
  }
}
