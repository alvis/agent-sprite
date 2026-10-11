import { CommandFault, providerErrorCode } from '#errors';
import { checkOperation, runBoundedIO } from '#operation';

import { isRecord } from '#utilities/guards';

import { guestServiceRequest } from './transaction.js';

import type { Sprite } from '@fly/sprites';

const REGISTRY_TIMEOUT_MS = 30_000;
const REGISTRY_SUCCESS_STATUS = 200;
const SERVICE_STATUSES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
];

/** validated registry facts needed to remove a tailnet dependency */
export interface GuestServiceRegistration {
  name: string;
  needs: string[];
  state?: { status: string };
}

/**
 * reads the complete registry before inferring daemon or consumer absence
 *
 * the Sprites OpenAPI 0.1.12 documents GET /v1/sprites/{name}/services as a
 * ServiceResponse array, with required name, cmd, args and needs fields;
 * the SDK listServices turns unknown envelopes such as {} into [], losing
 * absence evidence; only this read bypasses that normalization; mutations
 * remain owned by the SDK, using its public client baseURL and token here
 * @param sprite exact target guest
 * @returns one fully validated registry snapshot
 */
export async function readGuestServiceRegistry(
  sprite: Sprite,
): Promise<GuestServiceRegistration[]> {
  return runBoundedIO(async (signal) =>
    guestServiceRequest(sprite, async () =>
      requestRegistry(
        sprite,
        signal ?? AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      ),
    ),
  );
}

/**
 * retains raw provider data until validation and suppresses unsafe diagnostics
 * @param sprite exact target guest and official SDK client
 * @param signal caller cancellation and transport deadline
 * @returns validated registry records
 */
async function requestRegistry(
  sprite: Sprite,
  signal: AbortSignal,
): Promise<GuestServiceRegistration[]> {
  try {
    const response = await fetch(
      `${sprite.client.baseURL}/v1/sprites/${encodeURIComponent(sprite.name)}/services`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${sprite.client.token}` },
        redirect: 'error',
        signal,
      },
    );
    if (response.status !== REGISTRY_SUCCESS_STATUS) {
      await response.body?.cancel().catch(() => undefined);
      throw new CommandFault({
        code: providerErrorCode(response.status),
        message: `Service registry request failed (status ${response.status}).`,
      });
    }
    const data: unknown = await response.json();

    return parseRegistry(data);
  } catch (error) {
    checkOperation();
    signal.throwIfAborted();
    if (error instanceof CommandFault) {
      throw error;
    }
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Service registry response could not be read.',
      cause: error,
      causeVisibility: 'private',
    });
  }
}

/**
 * rejects partial, malformed and ambiguous successful provider responses
 * @param data untrusted HTTP response body
 * @returns complete records with unique service identities
 */
function parseRegistry(data: unknown): GuestServiceRegistration[] {
  if (!Array.isArray(data)) {
    throw invalidRegistry();
  }
  const names = new Set<string>();

  return data.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      typeof entry.cmd !== 'string' ||
      !isStringArray(entry.args) ||
      !isStringArray(entry.needs) ||
      (entry.http_port !== undefined &&
        entry.http_port !== null &&
        !Number.isInteger(entry.http_port)) ||
      names.has(entry.name)
    ) {
      throw invalidRegistry();
    }
    names.add(entry.name);

    return {
      name: entry.name,
      needs: entry.needs,
      state: parseServiceState(entry.state, entry.name),
    };
  });
}

/**
 * validates documented runtime fields before trusting service status
 * @param state untrusted optional runtime state
 * @param name enclosing service identity
 * @returns validated status, if runtime state is present
 */
function parseServiceState(
  state: unknown,
  name: string,
): GuestServiceRegistration['state'] {
  if (state === undefined || state === null) {
    return undefined;
  }
  if (
    !isRecord(state) ||
    state.name !== name ||
    typeof state.status !== 'string' ||
    !SERVICE_STATUSES.includes(state.status) ||
    (state.pid !== undefined && !Number.isInteger(state.pid)) ||
    (state.started_at !== undefined && typeof state.started_at !== 'string') ||
    (state.error !== undefined && typeof state.error !== 'string')
  ) {
    throw invalidRegistry();
  }

  return { status: state.status };
}

/**
 * validates required provider argument and dependency arrays
 * @param value untrusted registry field
 * @returns whether every member is a string
 */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/**
 * reports invalid evidence without including provider bodies or credentials
 * @returns typed provider failure
 */
function invalidRegistry(): CommandFault {
  return new CommandFault({
    code: 'PROVIDER',
    message: 'Service registry response is not a complete valid service list.',
  });
}
