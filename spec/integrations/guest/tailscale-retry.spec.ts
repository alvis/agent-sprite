import { randomBytes } from 'node:crypto';
import { mkdtempDisposable } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ServiceLogStream, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { writeResult } from '#cli/output';
import { CommandFault, commandError } from '#errors';
import { readGuestManifest } from '#integrations/guest/manifest';
import { readGuestServiceRegistry } from '#integrations/guest/service-registry';
import { disableTailscale } from '#integrations/guest/tailscale';
import { InteractionExit } from '#navigation';
import { OperationContext, withOperation } from '#operation';

import { createFilesystemSprite } from '../../mocks/sprites.js';

import type { ServiceWithState, Sprite } from '@fly/sprites';

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
    '/opt/agent-sprite/node/bin/node',
    '/opt/agent-sprite/t3-launcher.js',
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
 * A real temporary manifest and SDK-only service boundary for disabled retry.
 * @param root Temporary filesystem root.
 * @param baseURL Local service registry endpoint.
 * @param token Generated fixture credential.
 */
async function retrySprite(root: string, baseURL: string, token: string) {
  const sprite = Object.assign(
    createFilesystemSprite({
      root,
      execute: async (_file, args = []) => ({
        stdout: args.includes('/usr/bin/id')
          ? '1000\n'
          : args.includes('--help')
            ? '--log-level --no-browser'
            : '',
        stderr: '',
        exitCode: 0,
      }),
    }),
    { client: new SpritesClient(token, { baseURL }) },
  );
  await sprite.filesystem().mkdir('/opt/agent-sprite/t3-provider-probe', {
    recursive: true,
  });
  await sprite.filesystem().mkdir('/etc/cron.d', { recursive: true });
  await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
    schema: 1,
    createdAt: '2026-10-09T00:00:00Z',
    installedVersions: {},
    integrations: { tailscale: true, exitNode: false, cliproxyapi: false },
  });

  return sprite;
}

/**
 * Rejects unexpected SDK service mutations before they can reach a provider.
 * @param sprite temporary filesystem Sprite
 * @returns spies for each mutating service operation
 */
function rejectServiceMutations(sprite: Sprite) {
  const create = vi
    .spyOn(sprite, 'createService')
    .mockRejectedValue(new Error('unexpected service creation'));
  const stop = vi
    .spyOn(sprite, 'stopService')
    .mockRejectedValue(new Error('unexpected service stop'));
  const remove = vi
    .spyOn(sprite, 'deleteService')
    .mockRejectedValue(new Error('unexpected service deletion'));

  return { create, stop, remove };
}

const uncertainRegistryReplies = [
  { name: 'unknown envelope', reply: { status: 200, body: '{}' } },
  {
    name: 'null services envelope',
    reply: { status: 200, body: '{"services":null}' },
  },
  { name: 'null body', reply: { status: 200, body: 'null' } },
  {
    name: 'malformed record',
    reply: { status: 200, body: JSON.stringify([{ ...t3, cmd: 42 }]) },
  },
  {
    name: 'incomplete record',
    reply: { status: 200, body: '[{"name":"t3-code"}]' },
  },
  {
    name: 'duplicate service names',
    reply: { status: 200, body: JSON.stringify([t3, t3]) },
  },
  { name: 'invalid JSON', reply: { status: 200, body: '{' } },
  { name: 'partial HTTP response', reply: { status: 206, body: '[]' } },
  {
    name: 'unauthorized',
    reply: { status: 401, body: 'raw-registry-provider-body' },
  },
  {
    name: 'permission failure',
    reply: { status: 403, body: 'raw-registry-provider-body' },
  },
  {
    name: 'provider failure',
    reply: { status: 500, body: 'raw-registry-provider-body' },
  },
  { name: 'aborted transport', reply: { kind: 'abort' } },
] satisfies Array<{ name: string; reply: RegistryReply }>;

describe('fn:disableTailscale recovery ordering', () => {
  it('should accept a complete empty registry without installing absent T3', async () => {
    await using registry = await registryServer({ status: 200, body: '[]' });
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-tailnet-retry-absent-'),
    );
    const sprite = await retrySprite(
      directory.path,
      registry.baseURL,
      registry.token,
    );
    const mutations = rejectServiceMutations(sprite);

    await disableTailscale(sprite);

    expect(registry.requests).toEqual([
      {
        method: 'GET',
        path: '/v1/sprites/temporary/services',
        authorization: `Bearer ${registry.token}`,
      },
    ]);
    expect(mutations.create).not.toHaveBeenCalled();
    expect(mutations.stop).not.toHaveBeenCalled();
    expect(mutations.remove).not.toHaveBeenCalled();
    expect((await readGuestManifest(sprite)).integrations).toMatchObject({
      tailscale: false,
      exitNode: false,
    });
  });

  it('should reconcile an already registered T3 and leaves tailnet unregistered', async () => {
    await using registry = await registryServer({
      status: 200,
      body: JSON.stringify([{ ...t3, http_port: t3.httpPort }]),
    });
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-tailnet-retry-registered-'),
    );
    const sprite = await retrySprite(
      directory.path,
      registry.baseURL,
      registry.token,
    );
    const create = vi
      .spyOn(sprite, 'createService')
      .mockImplementation(
        async () =>
          new ServiceLogStream(
            new Response('{"type":"complete","timestamp":0}\n'),
          ),
      );
    vi.spyOn(sprite, 'stopService').mockRejectedValue(
      new Error('unexpected service stop'),
    );
    vi.spyOn(sprite, 'deleteService').mockRejectedValue(
      new Error('unexpected service deletion'),
    );

    await disableTailscale(sprite);

    expect(registry.requests[0]).toEqual({
      method: 'GET',
      path: '/v1/sprites/temporary/services',
      authorization: `Bearer ${registry.token}`,
    });
    expect(create.mock.calls.map(([name]) => name)).toEqual([
      't3-code',
      'agent-sprite-cron',
    ]);
    expect((await readGuestManifest(sprite)).integrations?.tailscale).toBe(
      false,
    );
  });

  it.each(uncertainRegistryReplies)(
    'should reject $name without service mutation or manifest change',
    async ({ reply }) => {
      await using registry = await registryServer(reply);
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-tailnet-retry-uncertain-'),
      );
      const sprite = await retrySprite(
        directory.path,
        registry.baseURL,
        registry.token,
      );
      const mutations = rejectServiceMutations(sprite);
      const manifest = await readGuestManifest(sprite);

      const failure: unknown = await disableTailscale(sprite).then(
        () => {
          throw new Error('Expected registry failure');
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CommandFault);
      if (!(failure instanceof CommandFault)) {
        throw new Error('Expected a typed registry failure');
      }
      expect(failure.code).toBe(
        'status' in reply && (reply.status === 401 || reply.status === 403)
          ? 'AUTH'
          : 'PROVIDER',
      );
      const diagnostic = JSON.stringify(commandError(failure));
      expect(diagnostic).not.toContain(registry.token);
      expect(diagnostic).not.toContain('raw-registry-provider-body');
      if ('kind' in reply || ('status' in reply && reply.body === '{')) {
        expect(failure.cause).toBeInstanceOf(Error);
      }
      expect(registry.requests).toEqual([
        {
          method: 'GET',
          path: '/v1/sprites/temporary/services',
          authorization: `Bearer ${registry.token}`,
        },
      ]);
      expect(mutations.create).not.toHaveBeenCalled();
      expect(mutations.stop).not.toHaveBeenCalled();
      expect(mutations.remove).not.toHaveBeenCalled();
      expect(await readGuestManifest(sprite)).toEqual(manifest);
    },
  );

  it('should preserve cancellation identity during a pending registry read', async () => {
    await using registry = await registryServer({ kind: 'hold' });
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-tailnet-retry-cancel-'),
    );
    const sprite = await retrySprite(
      directory.path,
      registry.baseURL,
      registry.token,
    );
    const mutations = rejectServiceMutations(sprite);
    const manifest = await readGuestManifest(sprite);
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    const operation = withOperation(context, async () =>
      disableTailscale(sprite),
    );
    await vi.waitFor(() => expect(registry.requests).toHaveLength(1));
    controller.abort();

    await expect(operation).rejects.toBeInstanceOf(InteractionExit);
    await expect(operation).rejects.toMatchObject({ action: 'cancel' });
    expect(mutations.create).not.toHaveBeenCalled();
    expect(mutations.stop).not.toHaveBeenCalled();
    expect(mutations.remove).not.toHaveBeenCalled();
    expect(await readGuestManifest(sprite)).toEqual(manifest);
  });
});

describe('fn:readGuestServiceRegistry private cause boundary', () => {
  it('should retain the raw SyntaxError internally but hides even a provider-body fragment through nested causes', async () => {
    await using registry = await registryServer({
      status: 200,
      body: '{"entry": PRIVATE_PROVIDER_BODY_SENTINEL',
    });
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-registry-private-cause-'),
    );
    const sprite = await retrySprite(
      directory.path,
      registry.baseURL,
      registry.token,
    );
    const failure: unknown = await readGuestServiceRegistry(sprite).catch(
      (error: unknown) => error,
    );
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
