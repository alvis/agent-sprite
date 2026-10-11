import { WebSocket } from 'ws';

import { isRecord } from '../records.js';

import type { RawData } from 'ws';

/** one native Effect RPC request */
export interface ProviderRequest {
  id: string;
  tag: string;
  payload: Record<string, unknown>;
}
/** exact response ownership and completion callback */
interface RpcFrameParams {
  socket: WebSocket;
  requestId: string;
  data: RawData;
  finish: (error?: Error, value?: Record<string, unknown>) => void;
}

const socketTimeoutMs = 10_000;
const rpcTimeoutMs = 30_000;
const maxResponseBytes = 1_048_576;

/**
 * authenticates a loopback WebSocket using a short-lived native bearer session
 * @param token native administrative bearer token
 * @returns connected authenticated socket
 */
export async function openAuthenticatedSocket(
  token: string,
): Promise<WebSocket> {
  const socket = new WebSocket('ws://127.0.0.1:3773/ws', {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: socketTimeoutMs,
    maxPayload: maxResponseBytes,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.on('error', reject);
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }

  return socket;
}

/**
 * sends one supported non-streaming Effect RPC request with bounded response time
 * @param socket authenticated T3 connection
 * @param request request identity, tag, and native payload
 * @returns successful RPC value
 */
export async function callRpc(
  socket: WebSocket,
  request: ProviderRequest,
): Promise<Record<string, unknown>> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('T3 connection is closed');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onFailure);
      socket.off('close', onFailure);
      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    };
    const onFailure = (): void => finish(new Error('T3 connection failed'));
    const onMessage = (data: RawData): void =>
      handleRpcFrames({
        socket,
        requestId: request.id,
        data,
        finish,
      });
    const timer = setTimeout(
      () => finish(new Error('T3 provider RPC timed out')),
      rpcTimeoutMs,
    );
    socket.on('message', onMessage);
    socket.on('error', onFailure);
    socket.on('close', onFailure);
    socket.send(
      JSON.stringify({ _tag: 'Request', ...request, headers: [] }),
      (error) => {
        if (error) {
          finish(new Error('T3 provider request failed'));
        }
      },
    );
  });
}

/**
 * handles single or batched native JSON frames and exact request completion
 * @param params socket, request identity, frame data, and completion callback
 */
function handleRpcFrames(params: RpcFrameParams): void {
  const { socket, requestId, data, finish } = params;
  try {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    for (const response of Array.isArray(decoded) ? decoded : [decoded]) {
      if (!isRecord(response)) {
        throw new Error('T3 protocol frame is invalid');
      }
      if (response._tag === 'Ping') {
        socket.send(JSON.stringify({ _tag: 'Pong' }));
      } else if (response._tag === 'Exit' && response.requestId === requestId) {
        if (
          !isRecord(response.exit) ||
          response.exit._tag !== 'Success' ||
          !isRecord(response.exit.value)
        ) {
          throw new Error('T3 provider RPC failed');
        }
        finish(undefined, response.exit.value);
      }
    }
  } catch {
    finish(new Error('T3 returned an invalid provider response'));
  }
}
