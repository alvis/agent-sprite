import { describe, expect, it, vi } from 'vitest';

import { FlyApi } from '#adapters/drivers/providers/fly-machine/api';

import type { MachineSpec } from '#adapters/drivers/providers/fly-machine/machine-config';

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/**
 * returns one Machines API response with the supplied JSON body
 * @param body response body, or none for a bodyless response
 * @param status HTTP status
 * @returns the response delivered to the API client
 */
function reply(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * serves queued responses at the fetch boundary and records sent requests
 * @param responses responses in request order
 * @returns requests the API client sent
 */
function useReplies(responses: readonly Response[]): SeenRequest[] {
  const remaining = [...responses];
  const seen: SeenRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : input,
      );
      seen.push({
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        authorization: new Headers(init?.headers).get('authorization'),
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      });

      return remaining.shift() ?? reply({ error: 'unexpected request' }, 400);
    }),
  );

  return seen;
}

describe('cl:FlyApi', () => {
  it('should accept a trimmed token with or without its scheme and resolve one organization', async () => {
    const seen = useReplies([
      reply({ tokens: [{ org_slug: 'team' }, { org_slug: 'team' }] }),
      reply({ tokens: [{ org_slug: 'team' }] }),
    ]);

    const first = await new FlyApi('  token  ').organization();
    const second = await new FlyApi('FlyV1 token').organization();

    expect({ first, second, seen }).toEqual({
      first: 'team',
      second: 'team',
      seen: [
        {
          method: 'GET',
          path: '/v1/tokens/current',
          authorization: 'FlyV1 token',
          body: undefined,
        },
        {
          method: 'GET',
          path: '/v1/tokens/current',
          authorization: 'FlyV1 token',
          body: undefined,
        },
      ],
    });
  });

  it.each([
    { tokens: [], issue: 'no organization' },
    {
      tokens: [{ org_slug: 'team' }, { org_slug: 'other' }],
      issue: 'multiple organizations',
    },
  ])('should reject a token with $issue', async ({ tokens }) => {
    useReplies([reply({ tokens })]);

    await expect(new FlyApi('token').organization()).rejects.toMatchObject({
      code: 'authentication',
    });
  });

  it('should return the nearest region and reject a response without one', async () => {
    useReplies([reply({ nearest: 'lhr' }), reply({ regions: [] })]);
    const api = new FlyApi('token');

    expect(await api.nearestRegion()).toBe('lhr');
    await expect(api.nearestRegion()).rejects.toMatchObject({ code: 'failed' });
  });

  it('should read an app, report absence, and preserve other lookup failures', async () => {
    const app = {
      id: 'app-1',
      name: 'team-app',
      internal_numeric_id: 42,
      organization: { slug: 'team' },
    };
    const seen = useReplies([
      reply(app),
      reply(app),
      reply({ error: 'missing' }, 404),
      reply({ error: 'forbidden' }, 403),
    ]);
    const api = new FlyApi('token');

    expect(await api.getApp('team-app')).toEqual({
      id: 'app-1',
      name: 'team-app',
      numericId: 42,
      organization: 'team',
    });
    expect(await api.hasApp('team-app')).toBe(true);
    expect(await api.hasApp('missing-app')).toBe(false);
    await expect(api.hasApp('forbidden-app')).rejects.toMatchObject({
      code: 'authentication',
    });
    expect(seen).toEqual(
      ['team-app', 'team-app', 'missing-app', 'forbidden-app'].map((name) => ({
        method: 'GET',
        path: `/v1/apps/${name}`,
        authorization: 'FlyV1 token',
        body: undefined,
      })),
    );
  });

  it('should create and delete an app with its organization', async () => {
    const seen = useReplies([reply(undefined, 204), reply(undefined, 204)]);
    const api = new FlyApi('token');

    await api.createApp('team-app', 'team');
    await api.deleteApp('team-app');

    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/apps',
        authorization: 'FlyV1 token',
        body: { name: 'team-app', org_slug: 'team' },
      },
      {
        method: 'DELETE',
        path: '/v1/apps/team-app',
        authorization: 'FlyV1 token',
        body: undefined,
      },
    ]);
  });

  it('should classify a globally taken app name as a conflict and preserve other refusals', async () => {
    useReplies([
      reply({ error: 'name already taken' }, 422),
      reply({ error: 'invalid name' }, 422),
      reply({ error: 'taken by another account' }, 401),
    ]);
    const api = new FlyApi('token');

    await expect(api.createApp('taken', 'team')).rejects.toMatchObject({
      code: 'conflict',
      cause: expect.objectContaining({ code: 'failed' }),
    });
    await expect(api.createApp('invalid', 'team')).rejects.toMatchObject({
      code: 'failed',
    });
    await expect(api.createApp('forbidden', 'team')).rejects.toMatchObject({
      code: 'authentication',
    });
  });

  it('should create resources and list machines across organization pages', async () => {
    const machine = {
      id: 'machine-1',
      state: 'started',
      config: {
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
        metadata: { owner: 'team' },
      },
    };
    const seen = useReplies([
      reply({ id: 'volume-1' }),
      reply(machine),
      reply([machine]),
      reply({
        machines: [{ ...machine, app_name: 'team-app' }],
        next_cursor: 'second',
        error_regions: [],
      }),
      reply({ machines: [], error_regions: [] }),
    ]);
    const api = new FlyApi('token');
    const spec: MachineSpec = {
      image: 'debian:bookworm-slim',
      guest: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
      init: ['/init'],
      files: [{ guestPath: '/boot', contents: 'boot', mode: 0o755 }],
      stopSeconds: 10,
      rootfs: 'always',
      volume: 'volume-1',
      mountPath: '/data',
      port: 3939,
      metadata: { owner: 'team' },
    };

    const volume = await api.createVolume('team-app', {
      name: 'data',
      region: 'lhr',
      sizeGb: 10,
    });
    const created = await api.createMachine('team-app', {
      name: 'workstation',
      region: 'lhr',
      spec,
    });
    const listed = await api.listMachines('team-app');
    const organization = await api.listOrganizationMachines('team');

    expect({ volume, created, listed, organization }).toEqual({
      volume: 'volume-1',
      created: {
        id: 'machine-1',
        state: 'started',
        guest: spec.guest,
        metadata: { owner: 'team' },
        routes: [],
      },
      listed: [
        {
          id: 'machine-1',
          state: 'started',
          guest: spec.guest,
          metadata: { owner: 'team' },
          routes: [],
        },
      ],
      organization: [
        {
          id: 'machine-1',
          state: 'started',
          guest: spec.guest,
          metadata: { owner: 'team' },
          routes: [],
          app: 'team-app',
        },
      ],
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/apps/team-app/volumes',
        authorization: 'FlyV1 token',
        body: { name: 'data', region: 'lhr', size_gb: 10 },
      },
      {
        method: 'POST',
        path: '/v1/apps/team-app/machines',
        authorization: 'FlyV1 token',
        body: {
          name: 'workstation',
          region: 'lhr',
          config: expect.objectContaining({
            image: spec.image,
            guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
            mounts: [{ volume: 'volume-1', path: '/data' }],
            metadata: { owner: 'team' },
          }),
        },
      },
      ...[
        '/v1/apps/team-app/machines',
        '/v1/orgs/team/machines',
        '/v1/orgs/team/machines?cursor=second',
      ].map((path) => ({
        method: 'GET',
        path,
        authorization: 'FlyV1 token',
        body: undefined,
      })),
    ]);
  });

  it('should reject an incomplete organization listing', async () => {
    useReplies([reply({ machines: [], error_regions: ['lhr'] })]);

    await expect(
      new FlyApi('token').listOrganizationMachines('team'),
    ).rejects.toMatchObject({ code: 'transient' });
  });

  it('should start a machine and wait for either any run or a named replacement run', async () => {
    const seen = useReplies([
      reply(undefined, 204),
      reply(undefined, 204),
      reply(undefined, 204),
    ]);
    const api = new FlyApi('token');
    const target = { app: 'team-app', machine: 'machine/1' };

    await api.startMachine(target);
    await api.waitUntilStarted(target, 15);
    await api.waitUntilStarted(target, 30, 'replacement-run');

    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/v1/apps/team-app/machines/machine%2F1/start',
        authorization: 'FlyV1 token',
        body: undefined,
      },
      {
        method: 'GET',
        path: '/v1/apps/team-app/machines/machine%2F1/wait?state=started&timeout=15',
        authorization: 'FlyV1 token',
        body: undefined,
      },
      {
        method: 'GET',
        path: '/v1/apps/team-app/machines/machine%2F1/wait?state=started&timeout=30&instance_id=replacement-run',
        authorization: 'FlyV1 token',
        body: undefined,
      },
    ]);
  });

  it('should preserve the machine configuration while replacing its guest and waiting for the new run', async () => {
    const seen = useReplies([
      reply({
        instance_id: 'old-run',
        config: {
          image: 'debian:bookworm-slim',
          guest: {
            cpu_kind: 'shared',
            cpus: 1,
            memory_mb: 512,
            cpu_note: 'keep',
          },
          metadata: { owner: 'team' },
          services: [{ internal_port: 3939, autostart: true, autostop: 'off' }],
          restart: { policy: 'on-failure' },
        },
      }),
      reply({
        id: 'machine-1',
        instance_id: 'new-run',
        state: 'started',
        config: {
          guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 2048 },
          metadata: { owner: 'team' },
        },
      }),
      reply(undefined, 204),
    ]);
    const api = new FlyApi('token');
    const target = { app: 'team-app', machine: 'machine-1' };

    const updated = await api.updateMachine(target, {
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 2048,
    });

    expect(updated).toEqual({
      id: 'machine-1',
      instanceId: 'new-run',
      state: 'started',
      guest: { cpuKind: 'performance', cpus: 2, memoryMb: 2048 },
      metadata: { owner: 'team' },
      routes: [],
    });
    expect(seen).toEqual([
      {
        method: 'GET',
        path: '/v1/apps/team-app/machines/machine-1',
        authorization: 'FlyV1 token',
        body: undefined,
      },
      {
        method: 'POST',
        path: '/v1/apps/team-app/machines/machine-1',
        authorization: 'FlyV1 token',
        body: {
          config: {
            image: 'debian:bookworm-slim',
            guest: {
              cpu_kind: 'performance',
              cpus: 2,
              memory_mb: 2048,
              cpu_note: 'keep',
            },
            metadata: { owner: 'team' },
            services: [
              { internal_port: 3939, autostart: true, autostop: 'off' },
            ],
            restart: { policy: 'on-failure' },
          },
          current_version: 'old-run',
        },
      },
      {
        method: 'GET',
        path: '/v1/apps/team-app/machines/machine-1/wait?state=started&timeout=60&instance_id=new-run',
        authorization: 'FlyV1 token',
        body: undefined,
      },
    ]);
  });

  it('should patch metadata and return a guest command result', async () => {
    const seen = useReplies([
      reply(undefined, 204),
      reply({ exit_code: 7, stdout: 'out', stderr: 'err' }),
    ]);
    const api = new FlyApi('token');
    const target = { app: 'team-app', machine: 'machine-1' };

    await api.updateMetadata(target, { owner: 'new-team', retired: '' });
    const result = await api.exec(target, ['/bin/echo', 'hello'], 12);

    expect({ result, seen }).toEqual({
      result: { exitCode: 7, stdout: 'out', stderr: 'err' },
      seen: [
        {
          method: 'PATCH',
          path: '/v1/apps/team-app/machines/machine-1/metadata',
          authorization: 'FlyV1 token',
          body: { metadata: { owner: 'new-team', retired: '' } },
        },
        {
          method: 'POST',
          path: '/v1/apps/team-app/machines/machine-1/exec',
          authorization: 'FlyV1 token',
          body: { command: ['/bin/echo', 'hello'], timeout: 12 },
        },
      ],
    });
  });

  it('should list, assign, and release public addresses', async () => {
    const seen = useReplies([
      reply({
        ips: [
          { ip: '203.0.113.10', shared: true },
          { ip: '2001:db8::1', shared: false },
        ],
      }),
      reply(undefined, 204),
      reply(undefined, 204),
    ]);
    const api = new FlyApi('token');

    const addresses = await api.listIps('team-app');
    await api.assignIp('team-app', 'v6');
    await api.releaseIp('team-app', '2001:db8::1');

    expect({ addresses, seen }).toEqual({
      addresses: [
        { ip: '203.0.113.10', shared: true, type: 'shared_v4' },
        { ip: '2001:db8::1', shared: false, type: 'v6' },
      ],
      seen: [
        {
          method: 'GET',
          path: '/v1/apps/team-app/ip_assignments',
          authorization: 'FlyV1 token',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/v1/apps/team-app/ip_assignments',
          authorization: 'FlyV1 token',
          body: { type: 'v6' },
        },
        {
          method: 'DELETE',
          path: '/v1/apps/team-app/ip_assignments/2001%3Adb8%3A%3A1',
          authorization: 'FlyV1 token',
          body: undefined,
        },
      ],
    });
  });
});
