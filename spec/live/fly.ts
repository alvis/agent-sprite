import { catalog } from '#core/catalog';

import { isRunWorkstation } from './ownership';

import type { LiveInventory } from './providers';

/** one app as the Machines API lists it */
interface FlyAppSummary {
  /** app name */
  name: string;
}

/** one machine as the Machines API reports it */
interface FlyMachineSummary {
  /** machine metadata the manager labels its machines with */
  config?: { metadata?: Record<string, string> };
}

/** HTTP status of each resource a workstation app holds */
export interface FlyResourceStatus {
  /** the app itself */
  app: number;
  /** its machine listing */
  machines: number;
  /** its volume listing */
  volumes: number;
}

/** one machine of one app */
export interface FlyMachineTarget {
  /** app name */
  app: string;
  /** machine identity */
  machine: string;
}

/** the token's own description */
interface FlyTokenSummary {
  /** organizations the token is bound to */
  tokens?: Array<{ org_slug?: string }>;
}

/** the dotenv credential of the Fly Machine provider, as its prerequisites declare */
export const FLY_TOKEN_VARIABLE =
  catalog.providers['fly-machine'].prerequisites.credential.environment;

const API_URL = 'https://api.machines.dev/v1';
const GRAPHQL_URL = 'https://api.fly.io/graphql';
const SCHEME = 'FlyV1 ';
const MANAGED_KEY = 'open-agent';
const MANAGED_VALUE = 'managed';
const NOT_FOUND_STATUS = 404;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * a Fly Machines inventory the live cleanup sweeps alongside the selected
 * provider, independent of the driver it proves absent
 * @param token Fly organization token from the live dotenv file
 * @returns inventory of the token's organization
 */
export function createFlyInventory(token: string): LiveInventory {
  const authorization = authorizationOf(token);
  const request = async (path: string, method = 'GET'): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: { authorization },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const json = async <T>(path: string): Promise<T> => {
    const response = await request(path);
    if (!response.ok) {
      throw new Error(`Fly ${path} answered ${response.status}`);
    }

    return (await response.json()) as T;
  };
  const organization = async (): Promise<string> => {
    const { tokens } = await json<FlyTokenSummary>('/tokens/current');
    const slug = tokens?.[0]?.org_slug;
    if (!slug) {
      throw new Error('The live Fly token names no organization');
    }

    return slug;
  };
  const hasApp = async (name: string): Promise<boolean> => {
    const response = await request(`/apps/${encodeURIComponent(name)}`);
    if (response.status === NOT_FOUND_STATUS) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Fly app lookup of ${name} answered ${response.status}`);
    }

    return true;
  };

  return {
    name: 'fly-machine',
    async listWorkstations(prefix) {
      const { apps } = await json<{ apps?: FlyAppSummary[] }>(
        `/apps?org_slug=${encodeURIComponent(await organization())}`,
      );

      return (apps ?? [])
        .map(({ name }) => name)
        .filter((name) => name.startsWith(prefix));
    },
    hasWorkstation: hasApp,
    async deleteWorkstation(name, runId) {
      if (!isRunWorkstation(name, runId)) {
        throw new Error(`Refusing to delete Fly app ${name} outside ${runId}`);
      }
      const machines = await json<FlyMachineSummary[]>(
        `/apps/${encodeURIComponent(name)}/machines`,
      );
      if (
        machines.some(
          (machine) =>
            machine.config?.metadata?.[MANAGED_KEY] !== MANAGED_VALUE,
        )
      ) {
        throw new Error(
          `Refusing to delete Fly app ${name}: unmanaged machine`,
        );
      }
      const response = await request(
        `/apps/${encodeURIComponent(name)}`,
        'DELETE',
      );
      if (!response.ok && response.status !== NOT_FOUND_STATUS) {
        throw new Error(`Fly deletion of ${name} answered ${response.status}`);
      }
    },
  };
}

/**
 * reads the HTTP status of an app and of its machine and volume listings, so
 * a deletion can be proved to have removed all three
 * @param token Fly organization token from the live dotenv file
 * @param name app name
 * @returns status of the app, its machines and its volumes
 */
export async function flyResourceStatus(
  token: string,
  name: string,
): Promise<FlyResourceStatus> {
  const authorization = authorizationOf(token);
  const app = `${API_URL}/apps/${encodeURIComponent(name)}`;
  const [own, machines, volumes] = await Promise.all(
    [app, `${app}/machines`, `${app}/volumes`].map(async (url) => {
      const response = await fetch(url, {
        headers: { authorization },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();

      return response.status;
    }),
  );

  return { app: own ?? 0, machines: machines ?? 0, volumes: volumes ?? 0 };
}

/**
 * reads the addresses assigned to an app straight from the Machines API
 * @param token Fly organization token from the live dotenv file
 * @param name app name
 * @returns every assigned address
 */
export async function flyAddresses(
  token: string,
  name: string,
): Promise<string[]> {
  const { ips } = await flyJson<{ ips?: Array<{ ip: string }> }>(
    token,
    `/apps/${encodeURIComponent(name)}/ip_assignments`,
  );

  return (ips ?? []).map(({ ip }) => ip);
}

/**
 * lists the volume identities of an app
 * @param token Fly organization token from the live dotenv file
 * @param name app name
 * @returns volume identities
 */
export async function flyVolumeIds(
  token: string,
  name: string,
): Promise<string[]> {
  const volumes = await flyJson<Array<{ id: string }>>(
    token,
    `/apps/${encodeURIComponent(name)}/volumes`,
  );

  return volumes.map(({ id }) => id);
}

/**
 * reads a volume's state through the Fly GraphQL API, which finds a volume by
 * its identity alone and so outlives the app it belonged to
 * @param token Fly organization token from the live dotenv file
 * @param id volume identity
 * @returns its state, or undefined once Fly no longer knows the volume
 */
export async function flyVolumeState(
  token: string,
  id: string,
): Promise<string | undefined> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'authorization': authorizationOf(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: 'query($id: ID!) { volume(id: $id) { state } }',
      variables: { id },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const answer = (await response.json()) as {
    data?: { volume?: { state?: string } | null };
    errors?: Array<{ extensions?: { code?: string } }>;
  };
  const missing = answer.errors?.every(
    ({ extensions }) => extensions?.code === 'NOT_FOUND',
  );
  if (answer.errors && !missing) {
    throw new Error(`Fly volume lookup of ${id} failed`);
  }

  return answer.data?.volume?.state;
}

/**
 * stops a machine and waits until it has stopped
 * @param token Fly organization token from the live dotenv file
 * @param name app name
 * @param machine machine identity
 */
export async function stopFlyMachine(
  token: string,
  name: string,
  machine: string,
): Promise<void> {
  const path = `/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(machine)}`;
  await flyJson(token, `${path}/stop`, { method: 'POST' });
  await flyJson(token, `${path}/wait?state=stopped&timeout=60`);
}

/**
 * reads a machine's run state straight from the Machines API
 * @param token Fly organization token from the live dotenv file
 * @param name app name
 * @param machine machine identity
 * @returns run state
 */
export async function flyMachineState(
  token: string,
  name: string,
  machine: string,
): Promise<string> {
  const { state } = await flyJson<{ state: string }>(
    token,
    `/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(machine)}`,
  );

  return state;
}

/**
 * changes a machine's memory through the Machines API, which restarts the
 * machine into a cold boot with the new size
 * @param token Fly organization token from the live dotenv file
 * @param target the machine to resize
 * @param memoryMb new memory in megabytes
 */
export async function setFlyMachineMemory(
  token: string,
  target: FlyMachineTarget,
  memoryMb: number,
): Promise<void> {
  const path = `/apps/${encodeURIComponent(target.app)}/machines/${encodeURIComponent(target.machine)}`;
  const { config } = await flyJson<{
    config: { guest?: Record<string, unknown> };
  }>(token, path);
  await flyJson(token, path, {
    method: 'POST',
    body: {
      config: { ...config, guest: { ...config.guest, memory_mb: memoryMb } },
    },
  });
}

/**
 * reads a machine's memory straight from the Machines API
 * @param token Fly organization token from the live dotenv file
 * @param name app name
 * @param machine machine identity
 * @returns memory in megabytes
 */
export async function flyMachineMemory(
  token: string,
  name: string,
  machine: string,
): Promise<number | undefined> {
  const { config } = await flyJson<{
    config: { guest?: { memory_mb?: number } };
  }>(
    token,
    `/apps/${encodeURIComponent(name)}/machines/${encodeURIComponent(machine)}`,
  );

  return config.guest?.memory_mb;
}

/**
 * sends one Machines API request and decodes its JSON answer
 * @param token Fly organization token from the live dotenv file
 * @param path path below the API base
 * @param request HTTP method and JSON body of the request
 * @param request.method verb of the request, GET unless given
 * @param request.body payload sent as JSON, none unless given
 * @returns decoded answer
 */
async function flyJson<T>(
  token: string,
  path: string,
  request: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = request;
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: authorizationOf(token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // a wait may be held open for a minute
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Fly ${method} ${path.split('?')[0]} answered ${response.status}`,
    );
  }

  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/**
 * renders the Machines API authorization header of a token
 * @param token Fly token, with or without its scheme
 * @returns header value
 */
function authorizationOf(token: string): string {
  return token.startsWith(SCHEME) ? token : `${SCHEME}${token}`;
}
