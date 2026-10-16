import { randomBytes } from 'node:crypto';
import { mkdtempDisposable } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it } from 'vitest';

import { writeResult } from '#cli/output';
import { CommandFault, commandError } from '#errors';

import { createFilesystemSprite, guestOf } from '../../../../mocks/sprites';

import type { ServiceWithState } from '@fly/sprites';

import type { CommandResult } from '#command';

const t3 = {
  name: 't3-code',
  cmd: '/usr/bin/sudo',
  args: [
    '-n',
    '-E',
    '--',
    '/usr/sbin/runuser',
    '-u',
    'agent',
    '--',
    '/opt/open-agent/node/bin/node',
    '/opt/open-agent/drivers/agents/t3/launcher.sh',
  ],
  needs: [],
  httpPort: 3773,
  state: { name: 't3-code', status: 'running' },
} satisfies ServiceWithState;

type RegistryReply =
  { status: number; body: string } | { kind: 'abort' | 'hold' };

/**
 * Serves real registry bytes to the host reader over a local SDK endpoint.
 * @param reply HTTP response or transport failure to expose
 * @returns disposable server, generated token, and observed requests
 */
async function registryServer(reply: RegistryReply) {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
  }> = [];
  const token = randomBytes(24).toString('hex');
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    const servicePath = '/v1/sprites/temporary/services/';
    if (request.method === 'GET' && request.url?.startsWith(servicePath)) {
      const name = decodeURIComponent(request.url.slice(servicePath.length));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ...t3,
          name,
          http_port: t3.httpPort,
          state: { name, status: 'running' },
        }),
      );

      return;
    }
    if (
      request.method !== 'GET' ||
      request.url !== '/v1/sprites/temporary/services'
    ) {
      response.writeHead(404);
      response.end();

      return;
    }
    if ('kind' in reply) {
      if (reply.kind === 'abort') {
        response.destroy();
      }

      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Local registry server has no TCP address');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    [Symbol.asyncDispose]: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * a filesystem Sprite whose service registry is the local SDK endpoint
 * @param root temporary filesystem root
 * @param baseURL local service registry endpoint
 * @param token generated fixture credential
 * @returns a Sprite backed by the temporary root and the local registry
 */
function registrySprite(root: string, baseURL: string, token: string) {
  return Object.assign(createFilesystemSprite({ root }), {
    client: new SpritesClient(token, { baseURL }),
  });
}

describe('mt:SpriteServiceControl.list private cause boundary', () => {
  it('should retain the raw SyntaxError internally but hides even a provider-body fragment through nested causes', async () => {
    await using registry = await registryServer({
      status: 200,
      body: '{"entry": PRIVATE_PROVIDER_BODY_SENTINEL',
    });
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-registry-private-cause-'),
    );
    const sprite = registrySprite(
      directory.path,
      registry.baseURL,
      registry.token,
    );
    const failure: unknown = await guestOf(sprite)
      .services.list()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFault);
    if (!(failure instanceof CommandFault)) {
      throw new Error('Expected typed private registry failure');
    }
    expect(failure.cause).toBeInstanceOf(SyntaxError);
    expect(String((failure.cause as SyntaxError).message)).toContain(
      'PRIVATE_PR',
    );

    const nested = new CommandFault({
      code: 'PROVIDER',
      message: 'Service inspection failed',
      cause: failure,
    });
    const result: CommandResult = {
      command: 'setup',
      ok: false,
      error: { ...commandError(nested), machine: 'temporary' },
    };
    for (const json of [false, true]) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      let err = '';
      stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      try {
        writeResult(result, { json }, { stdout, stderr });
        const output = json ? out : err;
        expect(output).toContain('Service registry response could not be read');
        expect(output).not.toContain('PRIVATE_PR');
        expect(output).not.toContain(registry.token);
        if (json) {
          expect(err).toBe('');
          expect(JSON.parse(output)).toMatchObject({
            error: { code: 'PROVIDER' },
          });
          expect(output.trim().split('\n')).toHaveLength(1);
        } else {
          expect(out).toBe('');
        }
      } finally {
        stdout.destroy();
        stderr.destroy();
      }
    }
  });
});
