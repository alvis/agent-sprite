import { AGENT_BIN, AGENT_PATH } from '#integrations/guest/layout';
import { converse, GuestLineProcess } from '#integrations/native/line-process';
import { isRecord } from '#utilities/guards';

import { CODEX_HOME } from './paths.js';

import type { GuestChannel } from '#drivers/guest-channel';

/** one JSON-RPC request to the running app server */
export type CodexRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** the Codex CLI, kept in the agent's npm prefix */
const CODEX = `${AGENT_BIN}/codex`;
/** longest one conversation with the app server may take */
const CONVERSATION_LIMIT_MS = 45_000;
/** most output the app server may print in one conversation */
const OUTPUT_LIMIT_CHARS = 4_194_304;

/**
 * runs one Codex app server as the agent on the guest, initializes it, and
 * hands its requests to an exchange the host drives; notifications are
 * skipped and each reply is matched to its request
 * @param guest target guest
 * @param exchange the requests to make once the server is initialized
 * @returns what the exchange returns
 * @throws {Error} when a request fails, the server misbehaves or time runs out
 */
export async function withCodexAppServer<T>(
  guest: GuestChannel,
  exchange: (request: CodexRequest) => Promise<T>,
): Promise<T> {
  const server = new GuestLineProcess(
    guest,
    [CODEX, 'app-server', '--listen', 'stdio://'],
    {
      environment: { CODEX_HOME, PATH: AGENT_PATH },
      limits: {
        timeoutMs: CONVERSATION_LIMIT_MS,
        outputChars: OUTPUT_LIMIT_CHARS,
      },
    },
  );
  let nextId = 0;
  const request: CodexRequest = async (method, params) => {
    const id = nextId++;
    server.send({ id, method, params });
    for (;;) {
      const message = await server.next();
      // a request of the server's own carries a method, and its id is its own
      if (isRecord(message) && message.id === id && !('method' in message)) {
        if (message.error !== undefined || !isRecord(message.result)) {
          throw new Error(`Codex ${method} failed`);
        }

        return message.result;
      }
    }
  };

  return converse(server, async () => {
    await request('initialize', {
      clientInfo: { name: 'open-agent', title: 'Open Agent', version: '0.0.0' },
    });
    server.send({ method: 'initialized', params: {} });

    return exchange(request);
  });
}
