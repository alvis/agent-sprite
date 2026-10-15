import { request } from 'node:http';

import type { IncomingMessage } from 'node:http';

// Sprite awake adapter: keeps the workstation awake through one Sprite task
// whose expiry is the governor's deadline. The task API is the guest-local
// Unix socket every account may reach, so the adapter needs no credential and
// runs as the agent account. It uses Node built-ins only and never touches
// services

/** guest-local Sprite API socket */
const SPRITE_API_SOCKET = '/.sprite/api.sock';

/** the one task the adapter maintains; the API allows lowercase letters, digits and dashes */
const AWAKE_TASK = 'open-agent-awake';

/** longest a task may live, in seconds; the Sprite API rejects a larger expiry */
const TASK_EXPIRY_LIMIT_SECONDS = 3_600;

/**
 * longest one API request lives from start to end, however slowly the server
 * answers; the governor allows the adapter 1.4 s, so a request always ends
 * before the apply lock that serialises requests is released
 */
const REQUEST_TIMEOUT_MS = 1_200;

/** most response bytes the adapter keeps for an error message */
const RESPONSE_EXCERPT_BYTES = 256;

/** the answers the task API gives to a refresh and to a delete */
const STATUS_OK = 200;
const STATUS_DELETED = 204;
const STATUS_NOT_FOUND = 404;

const MS_PER_SECOND = 1000;

/** what one API request answered */
interface SpriteReply {
  /** HTTP status */
  status: number;
  /** leading part of the response body */
  excerpt: string;
}

/**
 * gathers the status and the start of the body of a response
 * @param response the Sprite's answer
 * @param handlers where the finished reply, or the failure, goes
 * @param handlers.onReply receives the reply once the response has ended
 * @param handlers.onFailure receives the error of a response that broke
 */
function collectReply(
  response: IncomingMessage,
  handlers: {
    onReply: (reply: SpriteReply) => void;
    onFailure: (error: Error) => void;
  },
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer) => {
    if (size < RESPONSE_EXCERPT_BYTES) {
      chunks.push(chunk);
      size += chunk.length;
    }
  });
  response.on('error', handlers.onFailure);
  response.on('end', () => {
    handlers.onReply({
      status: response.statusCode ?? 0,
      excerpt: Buffer.concat(chunks)
        .subarray(0, RESPONSE_EXCERPT_BYTES)
        .toString('utf8'),
    });
  });
}

/**
 * sends one request to the Sprite task API
 * @param method HTTP method
 * @param body JSON body, absent for a request without one
 * @returns the status and the start of the body
 */
async function callTaskApi(
  method: 'PUT' | 'DELETE',
  body?: string,
): Promise<SpriteReply> {
  return new Promise((resolve, reject) => {
    let reply: SpriteReply | undefined;
    let failure: Error | undefined;
    const outgoing = request(
      {
        socketPath: SPRITE_API_SOCKET,
        path: `/v1/tasks/${AWAKE_TASK}`,
        method,
        headers: {
          host: 'sprite',
          ...(body !== undefined && {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          }),
        },
      },
      (response) => {
        collectReply(response, {
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
      outgoing.destroy(new Error('the Sprite task API did not answer in time'));
    }, REQUEST_TIMEOUT_MS);
    outgoing.on('error', (error) => {
      failure = error;
    });
    // settled only once the request has really ended, so a caller holding a
    // lock around this call never releases it with a request still running
    outgoing.on('close', () => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
      } else if (reply) {
        resolve(reply);
      } else {
        reject(new Error('the Sprite task API closed without an answer'));
      }
    });
    outgoing.end(body);
  });
}

/**
 * makes the Sprite task expire at the deadline, or removes it when the deadline
 * has passed. The expiry is whole seconds from the request, rounded up, so the
 * task never ends before the deadline. A deadline further away than the Sprite
 * allows is applied at the longest expiry and then reported, so the governor
 * records that the workstation may sleep early
 * @param deadline the workstation stays awake at least until this instant
 * @throws {Error} when the API rejects the request or does not answer in time
 */
export async function applyAwakeDeadline(deadline: Date): Promise<void> {
  const remainingMs = deadline.getTime() - Date.now();
  if (remainingMs <= 0) {
    const reply = await callTaskApi('DELETE');
    if (reply.status !== STATUS_DELETED && reply.status !== STATUS_NOT_FOUND) {
      throw new Error(
        `Sprite task delete answered ${reply.status}: ${reply.excerpt}`,
      );
    }

    return;
  }
  const wantedSeconds = Math.ceil(remainingMs / MS_PER_SECOND);
  const expire = Math.min(wantedSeconds, TASK_EXPIRY_LIMIT_SECONDS);
  const reply = await callTaskApi('PUT', JSON.stringify({ expire }));
  if (reply.status !== STATUS_OK) {
    throw new Error(
      `Sprite task refresh answered ${reply.status}: ${reply.excerpt}`,
    );
  }
  if (wantedSeconds > expire) {
    throw new Error(
      `the Sprite keeps a task at most ${TASK_EXPIRY_LIMIT_SECONDS} seconds; the deadline is ${wantedSeconds} seconds away`,
    );
  }
}
