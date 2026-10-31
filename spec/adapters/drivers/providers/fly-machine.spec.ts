import {
  chmod,
  mkdtempDisposable,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';

import { describe, expect, it, vi } from 'vitest';

import { flyMachine } from '#adapters/drivers/providers/fly-machine';
import { WorkstationCreationFault } from '#domain/creation';
import { summarizeProfile } from '#domain/recorded';

import { ProviderFault } from '#kernel/provider-fault';

import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

import type { GuestProcess } from '#application/ports/guest-channel';
import type { WorkstationProfile } from '#domain/profile';

/** an app the fake Machines API holds */
interface FakeApp {
  /** slug of the owning organization */
  organization: string;
  /** machines as the API reports them */
  machines: Array<Record<string, unknown>>;
  /** assigned public addresses */
  ips: Array<{ ip: string; shared: boolean }>;
}

/** one request routed to the fake, split into its path segments */
interface FakeRequest {
  /** HTTP method */
  method: string;
  /** app name segment */
  name: string;
  /** collection below the app, such as machines or volumes */
  collection?: string;
  /** item identity within the collection */
  id?: string;
  /** action on the item, such as metadata or wait */
  action?: string;
  /** decoded JSON body */
  body: Record<string, unknown>;
}

/** what the fake answers */
interface FakeResponse {
  /** HTTP status */
  status: number;
  /** JSON body, when there is one */
  body?: unknown;
}

const ORGANIZATION = 'test-org';
const PORT = 3773;
const PROFILE: WorkstationProfile = {
  ...DISABLED_NETWORK_PROFILE,
  provider: 'fly-machine',
};
const SUMMARY = summarizeProfile(PROFILE);
const MANAGED_METADATA = {
  'open-agent': 'managed',
  'open-agent-schema': '1',
};
const AGENT_SERVICE = {
  protocol: 'tcp',
  internal_port: PORT,
  autostart: true,
  autostop: 'off',
};
const NOT_FOUND: FakeResponse = { status: 404, body: { error: 'not found' } };
const OK: FakeResponse = { status: 200 };
const FLYCTL_STAND_IN = [
  '#!/bin/sh',
  'here=$(dirname "$0")',
  'if [ "$1" = tokens ] && [ "$2" = attenuate ]; then',
  '  payload=$(cat)',
  '  echo attenuate >> "$here/attenuations"',
  '  if [ -f "$here/fail-first-attenuation" ]; then',
  '    rm "$here/fail-first-attenuation"',
  '    exit 2',
  '  fi',
  '  case "$payload" in',
  `    *'"type":"Action"'*) printf 'FlyV1 read,discharge\\n' ;;`,
  `    *'"type":"Mutations"'*) printf 'FlyV1 mutate,discharge\\n' ;;`,
  '    *) exit 2 ;;',
  '  esac',
  '  exit 0',
  'fi',
  'if [ "$1" = tokens ] && [ "$2" = debug ]; then',
  `  printf '[{"location":"https://api.fly.io/v1","caveats":[]},{"location":"https://api.fly.io/v1","caveats":[]},{"location":"https://discharge.fly.io","caveats":[]}]\\n'`,
  '  exit 0',
  'fi',
  'if [ "$1" = agent ]; then exit 0; fi',
  'if [ "$1" = ssh ]; then',
  '  echo ssh >> "$here/sessions"',
  '  for line; do :; done',
  '  /bin/sh -c "$line"',
  '  exit $?',
  'fi',
  'exit 2',
].join('\n');

/**
 * installs a local flyctl stand-in for the provider's real SSH path
 * @param directory temporary executable and configuration directory
 * @param failFirstAttenuation whether the first token derivation fails
 */
async function installFlyctl(
  directory: string,
  failFirstAttenuation = false,
): Promise<void> {
  const program = join(directory, 'fly');
  await writeFile(program, FLYCTL_STAND_IN);
  await chmod(program, 0o755);
  if (failFirstAttenuation) {
    await writeFile(join(directory, 'fail-first-attenuation'), 'once');
  }
  vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`);
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'config'));
}

/**
 * collects one streaming guest shell's supported result
 * @param guest process opened by the provider
 * @returns exit or error and captured streams
 */
async function finished(guest: GuestProcess): Promise<{
  outcome: { exit: number } | { error: unknown };
  stdout: string;
  stderr: string;
}> {
  const outcome = new Promise<{ exit: number } | { error: unknown }>(
    (resolve) => {
      guest.on('exit', (exit) => resolve({ exit }));
      guest.on('error', (error) => resolve({ error }));
    },
  );
  const [stdout, stderr] = await Promise.all([
    text(guest.stdout),
    text(guest.stderr),
  ]);

  return { outcome: await outcome, stdout, stderr };
}

/** a Machines API keeping apps, machines and addresses in memory */
class FakeMachinesApi {
  public readonly apps: Record<string, FakeApp>;
  /** the fake as a global fetch */
  public readonly fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(requestUrl(input));
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const response = this.#route(
      init?.method ?? 'GET',
      url.pathname.replace(/^\/v1/u, ''),
      body as Record<string, unknown>,
    );

    return new Response(
      response.body === undefined ? null : JSON.stringify(response.body),
      { status: response.status },
    );
  });

  /**
   * holds the apps present before a test
   * @param apps apps by name
   */
  constructor(apps: Record<string, FakeApp> = {}) {
    this.apps = { ...apps };
  }

  /**
   * answers one request
   * @param method HTTP method
   * @param path path below the API base
   * @param body decoded JSON body
   * @returns status and body
   */
  #route(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): FakeResponse {
    const [, resource, name, collection, id, action] = path
      .split('/')
      .map(decodeURIComponent);
    if (resource === 'tokens') {
      return { status: 200, body: { tokens: [{ org_slug: ORGANIZATION }] } };
    }
    if (resource === 'platform') {
      return { status: 200, body: { nearest: 'lhr' } };
    }
    if (resource === 'orgs') {
      return { status: 200, body: { machines: this.#allMachines() } };
    }
    if (name === undefined) {
      this.apps[String(body.name)] = {
        organization: String(body.org_slug),
        machines: [],
        ips: [],
      };

      return { status: 201 };
    }
    const app = this.apps[name];

    return app
      ? this.#routeApp(app, { method, name, collection, id, action, body })
      : NOT_FOUND;
  }

  /**
   * answers a request on one existing app
   * @param app app the request addresses, as the fake holds it
   * @param request the routed request
   * @returns status and body
   */
  #routeApp(app: FakeApp, request: FakeRequest): FakeResponse {
    switch (request.collection) {
      case undefined:
        return this.#appItself(app, request);
      case 'volumes':
        return { status: 200, body: { id: 'vol_1' } };
      case 'ip_assignments':
        return addresses(app, request);
      default:
        return machines(app, request);
    }
  }

  /**
   * reads or deletes an app
   * @param app app the request addresses, as the fake holds it
   * @param request the routed request
   * @returns status and body
   */
  #appItself(app: FakeApp, request: FakeRequest): FakeResponse {
    if (request.method === 'DELETE') {
      delete this.apps[request.name];

      return { status: 202 };
    }

    return {
      status: 200,
      body: {
        id: `app-${request.name}`,
        name: request.name,
        internal_numeric_id: 42,
        organization: { slug: app.organization },
      },
    };
  }

  /**
   * lists every machine with its app, as the organization listing does
   * @returns machines across apps
   */
  #allMachines(): Array<Record<string, unknown>> {
    return Object.entries(this.apps).flatMap(([name, app]) =>
      app.machines.map((machine) => ({ ...machine, app_name: name })),
    );
  }
}

/**
 * lists, assigns or releases an app's addresses
 * @param app app the request addresses, as the fake holds it
 * @param request the routed request
 * @returns status and body
 */
function addresses(app: FakeApp, request: FakeRequest): FakeResponse {
  if (request.method === 'POST') {
    app.ips.push(
      request.body.type === 'v6'
        ? { ip: '2a09:8280::1', shared: false }
        : { ip: '66.241.124.1', shared: true },
    );

    return OK;
  }
  if (request.method === 'DELETE') {
    app.ips = app.ips.filter(({ ip }) => ip !== request.id);

    return { status: 204 };
  }

  return { status: 200, body: { ips: app.ips } };
}

/**
 * lists, creates, waits on or labels an app's machines
 * @param app app the request addresses, as the fake holds it
 * @param request the routed request
 * @returns status and body
 */
function machines(app: FakeApp, request: FakeRequest): FakeResponse {
  if (request.id === undefined) {
    return request.method === 'POST'
      ? { status: 200, body: launch(app, request.body.config) }
      : { status: 200, body: app.machines };
  }
  const machine = app.machines.find(({ id }) => id === request.id);
  if (!machine) {
    return NOT_FOUND;
  }
  if (request.action === undefined && request.method === 'GET') {
    return { status: 200, body: machine };
  }
  if (request.action === undefined && request.method === 'POST') {
    machine.config = request.body.config;
    machine.state = 'started';
    machine.instance_id = 'resized-run';

    return { status: 200, body: machine };
  }
  if (request.action === 'metadata') {
    const config = machine.config as { metadata: Record<string, string> };
    const update = request.body.metadata as Record<string, string>;
    for (const [key, value] of Object.entries(update)) {
      config.metadata[key] = value;
    }
    config.metadata = Object.fromEntries(
      Object.entries(config.metadata).filter(([, value]) => value !== ''),
    );

    return { status: 204 };
  }
  if (request.action === 'exec') {
    return bootProbe(machine);
  }

  return OK;
}

/**
 * answers the boot probe, which reads the ready file beside the kernel's boot
 * id; a machine reports a finished boot unless it carries another outcome
 * @param machine machine as the fake holds it
 * @returns the exec result
 */
function bootProbe(machine: Record<string, unknown>): FakeResponse {
  const outcome = typeof machine.boot === 'string' ? machine.boot : 'ok';

  return {
    status: 200,
    body: { exit_code: 0, stdout: `boot-1 ${outcome}\nboot-1\n`, stderr: '' },
  };
}

/**
 * adds a created machine to an app
 * @param app app the request addresses, as the fake holds it
 * @param config machine configuration from the request
 * @returns the machine as the API reports it
 */
function launch(app: FakeApp, config: unknown): Record<string, unknown> {
  const machine = {
    id: 'machine-1',
    state: 'created',
    created_at: '2026-10-14T00:00:00Z',
    config,
  };
  app.machines.push(machine);

  return machine;
}

/**
 * reads the URL a fetch was called with
 * @param input fetch input
 * @returns absolute URL
 */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

/**
 * an app with one started machine
 * @param machine its configuration
 * @param machine.metadata machine metadata keys
 * @param machine.services declared services in API form
 * @returns the app as the fake holds it
 */
function heldApp(machine: {
  metadata: Record<string, string>;
  services: unknown[];
}): FakeApp {
  return {
    organization: ORGANIZATION,
    machines: [
      {
        id: 'machine-1',
        state: 'started',
        config: {
          metadata: { ...machine.metadata },
          services: machine.services,
        },
      },
    ],
    ips: [],
  };
}

/**
 * puts a stand-in answer in front of the fake for the requests it chooses
 * @param api fake Machines API answering every other request
 * @param answer the stand-in answer, or undefined to pass the request on
 * @returns a fetch answering as the stand-in or the fake
 */
function interposed(
  api: FakeMachinesApi,
  answer: (path: string, method: string) => Response | undefined,
): Pick<FakeMachinesApi, 'fetch'> {
  return {
    fetch: vi.fn<typeof fetch>(
      async (input, init) =>
        answer(new URL(requestUrl(input)).pathname, init?.method ?? 'GET') ??
        api.fetch(input, init),
    ),
  };
}

/**
 * a server failure asking the client to retry at once
 * @returns the response
 */
function unavailable(): Response {
  return new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    headers: { 'retry-after': '0' },
  });
}

/**
 * a refusal for the request rate, which Fly sends before acting on a request
 * @returns the response
 */
function rateLimited(): Response {
  return new Response(
    JSON.stringify({ error: 'resource_exhausted: rate limit exceeded' }),
    { status: 429 },
  );
}

/**
 * stubs the fake as the global fetch and binds the provider to a token
 * @param api fake Machines API
 * @returns the bound provider
 */
function bound(
  api: Pick<FakeMachinesApi, 'fetch'>,
): ReturnType<typeof flyMachine.authenticate> {
  vi.stubGlobal('fetch', api.fetch);

  return flyMachine.authenticate({
    credential: 'FlyV1 fm2_test',
    restorableServices: [],
  });
}

describe('cl:FlyMachineProvider', () => {
  it('should report missing host prerequisites before contacting Fly', async () => {
    const result = await flyMachine.preflight({
      findTool: async () => undefined,
      readVersion: async () => undefined,
    });

    expect(result.map(({ subject }) => subject)).toEqual([
      'fly',
      'FLY_API_TOKEN',
    ]);
  });

  it('should refuse a provider operation before a management token is bound', async () => {
    await expect(flyMachine.get('alpha')).rejects.toMatchObject({
      code: 'authentication',
      message: 'FLY_API_TOKEN is required.',
    });
  });

  describe('mt:create', () => {
    it('should create a private app whose machine declares the agent service and records ownership and profile', async () => {
      const api = new FakeMachinesApi();

      const record = await bound(api).create('alpha', PROFILE, PORT);

      expect({
        record,
        config: api.apps.alpha?.machines[0]?.config,
        addressCalls: api.fetch.mock.calls.filter(([input]) =>
          requestUrl(input).includes('ip_assignments'),
        ),
      }).toEqual({
        record: {
          id: 'machine-1',
          name: 'alpha',
          organization: ORGANIZATION,
          createdAt: '2026-10-14T00:00:00Z',
          state: 'started',
          url: 'https://alpha.fly.dev',
          machine: { cpus: 2, label: 'shared-cpu-2x', memoryGb: 2 },
          metadata: { setup: 'not recorded', profile: SUMMARY },
        },
        config: expect.objectContaining({
          image: 'debian:bookworm-slim',
          mounts: [{ volume: 'vol_1', path: '/data' }],
          services: [expect.objectContaining(AGENT_SERVICE)],
          metadata: expect.objectContaining(MANAGED_METADATA),
        }),
        addressCalls: [],
      });
    });

    it('should fall back to the default region when the override is blank', async () => {
      vi.stubEnv('OPEN_AGENT_FLY_REGION', '  ');
      const api = new FakeMachinesApi();

      await bound(api).create('alpha', PROFILE, PORT);

      expect(api.fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining('"region":"lhr"'),
        }),
      );
    });

    it('should create a machine Fly can suspend: at most 2 GB of memory, no swap and no schedule', async () => {
      const api = new FakeMachinesApi();

      await bound(api).create('alpha', PROFILE, PORT);
      const config = api.apps.alpha?.machines[0]?.config as {
        guest: { memory_mb: number };
      };

      expect({
        withinSuspendLimit: config.guest.memory_mb <= 2_048,
        swap: 'swap_size_mb' in config.guest || 'swap_size_mb' in config,
        schedule: 'schedule' in config,
      }).toEqual({ withinSuspendLimit: true, swap: false, schedule: false });
    });

    it('should remove the app again when its machine cannot be created', async () => {
      const api = new FakeMachinesApi();
      const failing = vi.fn<typeof fetch>(async (input, init) =>
        requestUrl(input).endsWith('/machines') && init?.method === 'POST'
          ? new Response(JSON.stringify({ error: 'capacity' }), { status: 503 })
          : api.fetch(input, init),
      );

      const result = bound({ fetch: failing }).create('alpha', PROFILE, PORT);

      await expect(result).rejects.toEqual(
        new WorkstationCreationFault({
          machine: 'alpha',
          outcome: 'absent',
          message:
            'Fly app creation for alpha failed; provider lookup confirmed no app with this name remains',
        }),
      );
      expect(api.apps).toEqual({});
    });
  });

  describe('mt:expose', () => {
    it('should assign a dedicated IPv6 and a shared IPv4 address once to publish the declared service', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);
      const record = await provider.get('alpha');

      await provider.expose(record, PORT, 'public');
      await provider.expose(record, PORT, 'public');

      expect(api.apps.alpha?.ips).toEqual([
        { ip: '2a09:8280::1', shared: false },
        { ip: '66.241.124.1', shared: true },
      ]);
    });

    it('should refuse to publish a port the machine declares no auto-starting service for', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [{ ...AGENT_SERVICE, autostop: 'suspend' }],
        }),
      });
      const provider = bound(api);
      const record = await provider.get('alpha');

      const result = provider.expose(record, PORT, 'public');

      await expect(result).rejects.toEqual(
        new ProviderFault({
          code: 'failed',
          message: `Fly machine of alpha declares no auto-starting service for port ${PORT}`,
        }),
      );
      expect(api.apps.alpha?.ips).toEqual([]);
    });

    it('should release every address to make the workstation private', async () => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const api = new FakeMachinesApi({
        alpha: {
          ...app,
          ips: [
            { ip: '2a09:8280::1', shared: false },
            { ip: '66.241.124.1', shared: true },
          ],
        },
      });
      const provider = bound(api);

      await provider.expose(await provider.get('alpha'), PORT, 'private');

      expect(api.apps.alpha?.ips).toEqual([]);
    });
  });

  describe('private Flycast addresses', () => {
    it('should neither count a private fdaa: address as public IPv6 nor release it', async () => {
      const flycast = { ip: 'fdaa:0:1:a7b::3', shared: false };
      const api = new FakeMachinesApi({
        alpha: {
          ...heldApp({ metadata: MANAGED_METADATA, services: [AGENT_SERVICE] }),
          ips: [flycast],
        },
      });
      const provider = bound(api);
      const record = await provider.get('alpha');

      await provider.expose(record, PORT, 'public');
      const published = [...(api.apps.alpha?.ips ?? [])];
      await provider.expose(record, PORT, 'private');

      expect({ published, kept: api.apps.alpha?.ips }).toEqual({
        published: [
          flycast,
          { ip: '2a09:8280::1', shared: false },
          { ip: '66.241.124.1', shared: true },
        ],
        kept: [flycast],
      });
    });
  });

  describe('mt:list', () => {
    it('should report one record per app, ignoring destroyed machines and apps that are no single managed machine', async () => {
      const managed = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const [machine] = managed.machines;
      const api = new FakeMachinesApi({
        alpha: {
          ...managed,
          machines: [
            { ...machine, id: 'machine-0', state: 'destroyed' },
            { ...machine, id: 'machine-9', state: 'destroying' },
            ...managed.machines,
          ],
        },
        beta: {
          ...managed,
          machines: [...managed.machines, { ...machine, id: 'machine-2' }],
        },
      });

      const listed = await bound(api).list();

      expect(listed.map(({ name, id }) => ({ name, id }))).toEqual([
        { name: 'alpha', id: 'machine-1' },
      ]);
    });
  });

  describe('reading workstations', () => {
    it('should resolve the organization again after the first token lookup fails', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const refusals = [
        new Response(JSON.stringify({ error: 'token refused' }), {
          status: 401,
        }),
      ];
      const provider = bound(
        interposed(api, (path) =>
          path === '/v1/tokens/current' ? refusals.shift() : undefined,
        ),
      );

      await expect(provider.get('alpha')).rejects.toMatchObject({
        code: 'authentication',
      });
      await expect(provider.get('alpha')).resolves.toMatchObject({
        id: 'machine-1',
        organization: ORGANIZATION,
      });
      expect(refusals).toEqual([]);
    });

    it('should neither start nor wake a stopped machine while listing and fetching it', async () => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const api = new FakeMachinesApi({
        alpha: {
          ...app,
          machines: app.machines.map((held) => ({ ...held, state: 'stopped' })),
        },
      });
      const provider = bound(api);

      const states = [
        ...(await provider.list()).map(({ state }) => state),
        (await provider.get('alpha')).state,
      ];

      expect({
        states,
        requests: new Set(
          api.fetch.mock.calls.map(
            ([input, init]) =>
              `${init?.method ?? 'GET'} ${new URL(requestUrl(input)).host}`,
          ),
        ),
      }).toEqual({
        states: ['stopped', 'stopped'],
        requests: new Set(['GET api.machines.dev']),
      });
    });

    it('should retry a read the API reports as transiently unavailable', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({ metadata: MANAGED_METADATA, services: [] }),
      });
      const failures = [unavailable(), unavailable()];
      const provider = bound(
        interposed(api, (path) =>
          path === '/v1/apps/alpha' ? failures.shift() : undefined,
        ),
      );

      const record = await provider.get('alpha');

      expect({ name: record.name, failures }).toEqual({
        name: 'alpha',
        failures: [],
      });
    });

    it('should report a successful answer that is not JSON as a failure', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({ metadata: MANAGED_METADATA, services: [] }),
      });
      const provider = bound(
        interposed(api, (path) =>
          path === '/v1/apps/alpha'
            ? new Response('<html>\n  maintenance\n</html>', { status: 200 })
            : undefined,
        ),
      );

      const result = provider.get('alpha');

      await expect(result).rejects.toEqual(
        new ProviderFault({
          code: 'failed',
          message:
            'Fly Machines API GET /apps/alpha returned a body that is not JSON: <html> maintenance </html>',
        }),
      );
    });
  });

  describe('mt:openGuest', () => {
    it('should reuse an opened channel without restarting or probing its boot again', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      const first = await provider.openGuest(workstation);
      const requestsAfterOpen = api.fetch.mock.calls.length;
      const second = await provider.openGuest(workstation);

      expect(second).toBe(first);
      expect(api.fetch.mock.calls).toHaveLength(requestsAfterOpen);
    });

    it.each([
      ['a starting machine without starting it again', 'starting', undefined],
      [
        'a machine whose start conflicts with one under way',
        'stopped',
        new Response(JSON.stringify({ error: 'already starting' }), {
          status: 409,
        }),
      ],
    ])('should wait for %s', async (_, state, startAnswer) => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const api = new FakeMachinesApi({
        alpha: {
          ...app,
          machines: app.machines.map((held) => ({ ...held, state })),
        },
      });
      const fetched = interposed(api, (path) =>
        path.endsWith('/start') ? startAnswer : undefined,
      );
      const provider = bound(fetched);

      await provider.openGuest(await provider.get('alpha'));

      expect(
        fetched.fetch.mock.calls
          .map(([input]) => new URL(requestUrl(input)).pathname)
          .filter((path) => /\/(?:start|wait)$/u.test(path)),
      ).toEqual([
        ...(startAnswer ? ['/v1/apps/alpha/machines/machine-1/start'] : []),
        '/v1/apps/alpha/machines/machine-1/wait',
      ]);
    });

    it('should repeat a guest command the API refused for its rate before running it', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const refusals = [rateLimited(), rateLimited()];
      const fetched = interposed(api, (path, method) =>
        method === 'POST' && path.endsWith('/exec')
          ? refusals.shift()
          : undefined,
      );
      const provider = bound(fetched);

      await provider.openGuest(await provider.get('alpha'));

      expect({
        refusals,
        execs: fetched.fetch.mock.calls.filter(([input]) =>
          requestUrl(input).endsWith('/exec'),
        ).length,
      }).toEqual({ refusals: [], execs: 3 });
    });

    it('should open a guest whose boot a critical step halted, for setup to repair', async () => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const api = new FakeMachinesApi({
        alpha: {
          ...app,
          machines: app.machines.map((held) => ({ ...held, boot: 'halted' })),
        },
      });
      const provider = bound(api);

      const result = provider.openGuest(await provider.get('alpha'));

      await expect(result).resolves.toBeDefined();
    });

    it('should refuse a guest whose boot could not bind its volume', async () => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const api = new FakeMachinesApi({
        alpha: {
          ...app,
          machines: app.machines.map((held) => ({ ...held, boot: 'failed' })),
        },
      });
      const provider = bound(api);

      const result = provider.openGuest(await provider.get('alpha'));

      await expect(result).rejects.toEqual(
        new ProviderFault({
          code: 'failed',
          message:
            "The Fly Machine machine-1 could not bind its volume's guest root; see fly logs",
        }),
      );
    });
  });

  describe('mt:openRootShell', () => {
    it('should stream through a root shell and reuse the app-scoped SSH token for a second shell', async () => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-fly-provider-shell-'),
      );
      await installFlyctl(directory.path);
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      const first = await provider.openRootShell(workstation, '/bin/sh');
      const firstResult = finished(first);
      first.stdin.end('echo first-shell\nexit 0\n');
      const second = await provider.openRootShell(workstation, '/bin/sh');
      const secondResult = finished(second);
      second.stdin.end('echo second-shell\nexit 0\n');

      expect([await firstResult, await secondResult]).toEqual([
        { outcome: { exit: 0 }, stdout: 'first-shell\n', stderr: '' },
        { outcome: { exit: 0 }, stdout: 'second-shell\n', stderr: '' },
      ]);
      expect(
        (await readFile(join(directory.path, 'attenuations'), 'utf8'))
          .trim()
          .split('\n'),
      ).toEqual(['attenuate', 'attenuate']);
    });

    it('should retry SSH token derivation after one attenuation failure', async () => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-fly-provider-token-retry-'),
      );
      await installFlyctl(directory.path, true);
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      const first = await provider.openRootShell(workstation, '/bin/sh');
      const firstResult = finished(first);
      first.stdin.end();
      const rejected = await firstResult;
      const second = await provider.openRootShell(workstation, '/bin/sh');
      const secondResult = finished(second);
      second.stdin.end('echo recovered\nexit 0\n');

      expect(rejected).toMatchObject({
        outcome: { error: { code: 'failed' } },
        stdout: '',
      });
      const recovered = await secondResult;
      expect(recovered).toMatchObject({
        outcome: { exit: 0 },
        stdout: 'recovered\n',
      });
      expect(recovered.stderr.trim()).toBe('');
      expect(
        (await readFile(join(directory.path, 'attenuations'), 'utf8'))
          .trim()
          .split('\n'),
      ).toEqual(['attenuate', 'attenuate', 'attenuate']);
    });
  });

  describe('mt:awaitGuestReady', () => {
    it('should return after the current boot answers and an SSH probe reaches the guest', async () => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-fly-provider-ready-'),
      );
      await installFlyctl(directory.path);
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      await expect(
        provider.awaitGuestReady(workstation),
      ).resolves.toBeUndefined();

      expect(await readFile(join(directory.path, 'sessions'), 'utf8')).toBe(
        'ssh\n',
      );
    });
  });

  describe('mt:setMetadata', () => {
    it('should record setup state and profile summary that list and get read back', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
        stranger: heldApp({ metadata: {}, services: [] }),
      });
      const provider = bound(api);
      const metadata = {
        setup: 'ready' as const,
        profile: SUMMARY,
        version: '1.2.3',
      };

      const recorded = await provider.setMetadata(
        await provider.get('alpha'),
        metadata,
      );
      const listed = await provider.list();
      const cleared = await provider.setMetadata(recorded, {
        setup: 'not recorded',
      });

      expect({
        recorded: recorded.metadata,
        listed: listed.map(({ name, metadata: read }) => ({ name, read })),
        cleared: cleared.metadata,
      }).toEqual({
        recorded: metadata,
        listed: [{ name: 'alpha', read: metadata }],
        cleared: { setup: 'not recorded', profile: SUMMARY, version: '1.2.3' },
      });
    });
  });

  describe('mt:resize', () => {
    it('should reject an unavailable machine size without updating the machine', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      await expect(
        provider.resize(workstation, {
          label: 'shared-cpu-3x',
          cpus: 3,
          memoryGb: 2,
        }),
      ).rejects.toMatchObject({
        code: 'failed',
        message: expect.stringContaining('shared-cpu-3x'),
      });
      expect(
        api.fetch.mock.calls.every(([, init]) => init?.method !== 'POST'),
      ).toBe(true);
    });

    it('should leave a machine already on the requested size untouched', async () => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const machine = app.machines[0]!;
      machine.config = {
        ...(machine.config as Record<string, unknown>),
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
      };
      const api = new FakeMachinesApi({ alpha: app });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      const resized = await provider.resize(workstation, {
        label: 'shared-cpu-2x',
        cpus: 2,
        memoryGb: 2,
      });

      expect(resized).toEqual(workstation);
      expect(
        api.fetch.mock.calls
          .map(([input, init]) => ({
            path: new URL(requestUrl(input)).pathname,
            method: init?.method ?? 'GET',
          }))
          .filter(({ method }) => method === 'POST'),
      ).toEqual([]);
    });

    it('should change only the guest size and return the restarted machine', async () => {
      const app = heldApp({
        metadata: MANAGED_METADATA,
        services: [AGENT_SERVICE],
      });
      const api = new FakeMachinesApi({ alpha: app });
      const provider = bound(api);
      const workstation = await provider.get('alpha');

      const resized = await provider.resize(workstation, {
        label: 'performance-4x',
        cpus: 4,
        memoryGb: 32,
      });

      expect(resized).toMatchObject({
        id: workstation.id,
        name: 'alpha',
        machine: { label: 'performance-4x', cpus: 4, memoryGb: 32 },
        metadata: workstation.metadata,
      });
      expect(app.machines[0]).toMatchObject({
        state: 'started',
        config: {
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
          guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 32768 },
        },
      });
    });
  });

  describe('mt:get', () => {
    it('should refuse an app of another organization', async () => {
      const api = new FakeMachinesApi({
        alpha: {
          ...heldApp({ metadata: MANAGED_METADATA, services: [] }),
          organization: 'other-org',
        },
      });

      const result = bound(api).get('alpha');

      await expect(result).rejects.toEqual(
        new ProviderFault({
          code: 'ownership-mismatch',
          message: `Fly app alpha does not belong to organization ${ORGANIZATION}`,
        }),
      );
    });

    it('should refuse an app whose machine open-agent does not manage', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({ metadata: {}, services: [] }),
      });

      const result = bound(api).get('alpha');

      await expect(result).rejects.toEqual(
        new ProviderFault({
          code: 'ownership-mismatch',
          message: 'Fly app alpha is not a verified open-agent workstation',
        }),
      );
    });
  });

  describe('mt:isNameTaken', () => {
    it('should preserve a non-access API failure when checking a name', async () => {
      const provider = bound(
        interposed(new FakeMachinesApi(), (path) =>
          path === '/v1/apps/ava'
            ? new Response(JSON.stringify({ error: 'malformed request' }), {
                status: 422,
              })
            : undefined,
        ),
      );

      await expect(provider.isNameTaken('ava')).rejects.toMatchObject({
        code: 'failed',
      });
    });

    it('should report a name another Fly account holds as a conflict, not an authentication failure', async () => {
      const provider = bound(
        interposed(new FakeMachinesApi(), (path) =>
          path === '/v1/apps/ava'
            ? new Response(JSON.stringify({ error: 'unauthorized' }), {
                status: 403,
              })
            : undefined,
        ),
      );

      const result = provider.isNameTaken('ava');

      await expect(result).rejects.toMatchObject({
        code: 'conflict',
        message:
          'Fly app name ava is already used by another Fly account; choose a different name',
      });
    });

    it('should keep an authentication failure when the token itself is refused', async () => {
      const provider = bound(
        interposed(
          new FakeMachinesApi(),
          () =>
            new Response(JSON.stringify({ error: 'unauthorized' }), {
              status: 403,
            }),
        ),
      );

      const result = provider.isNameTaken('ava');

      await expect(result).rejects.toMatchObject({ code: 'authentication' });
    });
  });

  describe('mt:delete', () => {
    it('should destroy the app with its machine and volume', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      const provider = bound(api);

      await provider.delete(await provider.get('alpha'));

      expect({
        apps: api.apps,
        taken: await provider.isNameTaken('alpha'),
      }).toEqual({ apps: {}, taken: false });
    });

    it('should keep waiting for the app to go while the API is transiently unavailable', async () => {
      const api = new FakeMachinesApi({
        alpha: heldApp({
          metadata: MANAGED_METADATA,
          services: [AGENT_SERVICE],
        }),
      });
      let deleted = false;
      // after deletion, every read of a whole retry round fails
      const failures = Array.from({ length: 4 }, unavailable);
      const provider = bound(
        interposed(api, (path, method) => {
          deleted ||= method === 'DELETE';

          return deleted && path === '/v1/apps/alpha' && method === 'GET'
            ? failures.shift()
            : undefined;
        }),
      );

      await provider.delete(await provider.get('alpha'));

      expect({ apps: api.apps, failures }).toEqual({ apps: {}, failures: [] });
    });

    it.each([
      {
        difference: 'another machine identity',
        observed: { id: 'machine-2' },
        metadata: MANAGED_METADATA,
        message: 'Fly app alpha changed identity or organization',
      },
      {
        difference: 'another organization',
        observed: { organization: 'other-org' },
        metadata: MANAGED_METADATA,
        message: 'Fly app alpha changed identity or organization',
      },
      {
        difference: 'a machine open-agent does not manage',
        observed: {},
        metadata: {},
        message: 'Fly app alpha is not a verified open-agent workstation',
      },
    ])(
      'should refuse to delete a workstation with $difference',
      async ({ observed, metadata, message }) => {
        const api = new FakeMachinesApi({
          alpha: heldApp({ metadata, services: [AGENT_SERVICE] }),
        });
        const provider = bound(api);
        const record = {
          id: 'machine-1',
          name: 'alpha',
          organization: ORGANIZATION,
          state: 'started',
          url: 'https://alpha.fly.dev',
          metadata: { setup: 'not recorded' as const },
          ...observed,
        };

        const result = provider.delete(record);

        await expect(result).rejects.toEqual(
          new ProviderFault({ code: 'ownership-mismatch', message }),
        );
        expect(Object.keys(api.apps)).toEqual(['alpha']);
      },
    );
  });
});
