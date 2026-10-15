import { APIError, SpritesClient } from '@fly/sprites';

import { catalog } from '#core/catalog';
import { MANAGED_LABEL } from '#drivers/providers/sprite/labels';

import { assertOwnedWorkstation } from './ownership.js';

import type { Sprite } from '@fly/sprites';

/** workstation providers the live harness can drive */
export type LiveProviderName = keyof typeof LIVE_PROVIDER_CREDENTIALS;

/** identifiers a live workstation carries, as observed at the provider */
export interface WorkstationIdentity {
  /** provider labels attached to the workstation */
  labels: readonly string[];
  /** direct children of the guest directories that hold manager state */
  guestPaths: readonly string[];
  /** contents of the guest maintenance schedule */
  schedule: string;
}

/** what the provider reports about one supervised service process */
export interface ServiceProcess {
  /** service name */
  name: string;
  /** current status */
  status: string;
  /** services it starts after */
  needs: string[];
  /** process id while running */
  pid: number | undefined;
  /** when the current process started */
  startedAt: string | undefined;
}

/** whether a workstation runs or sleeps, as the provider itself reports it */
export interface RunState {
  /** provider status; a Sprite is `running`, `warm` or `cold` */
  status: string;
  /** the provider's last transition to running */
  lastRunningAt: string | undefined;
  /** the provider's last transition to a sleeping state, which a Sprite reports only while asleep */
  lastWarmingAt: string | undefined;
}

/** workstations one provider account holds, with direct fallback deletion */
export interface LiveInventory {
  /** provider the inventory reads */
  readonly name: string;
  /**
   * lists every provider workstation whose name starts with the prefix
   * @param prefix exact name prefix
   * @returns matching names, managed or not
   */
  listWorkstations(prefix: string): Promise<string[]>;
  /**
   * tells whether the provider still has the exact workstation
   * @param name exact workstation name
   * @returns true while the provider reports it
   */
  hasWorkstation(name: string): Promise<boolean>;
  /**
   * deletes directly through the provider after rechecking name, run prefix and label
   * @param name exact workstation name
   * @param runId live run that must own the name
   */
  deleteWorkstation(name: string, runId: string): Promise<void>;
}

/** provider-specific create arguments, inventory, and fallback deletion */
export interface LiveProvider extends LiveInventory {
  /** provider selected for this run */
  readonly name: LiveProviderName;
  /** extra create flags this provider needs beyond the shared defaults */
  readonly createArgs: readonly string[];
  /**
   * reads the labels and manager-owned guest paths of a running workstation
   * @param name exact workstation name
   * @returns observed identifiers
   */
  inspectIdentity(name: string): Promise<WorkstationIdentity>;
  /**
   * runs a shell script in the guest as the provider's exec account (root)
   * @param name exact workstation name
   * @param script `sh -c` script
   * @returns the script's standard output
   * @throws {Error} when the script exits non-zero
   */
  execute(name: string, script: string): Promise<string>;
  /**
   * reads every supervised service's process identity straight from the provider
   * @param name exact workstation name
   * @returns services ordered by name, so two reads compare directly
   */
  snapshotServices(name: string): Promise<ServiceProcess[]>;
  /**
   * reads whether the workstation runs or sleeps through the management API,
   * which neither wakes it nor keeps it awake
   * @param name exact workstation name
   * @returns the state, or nothing when the provider answered with a record
   * that carries no status or transition times, which the Sprites API
   * sometimes does
   */
  readRunState(name: string): Promise<RunState | undefined>;
  /**
   * reads the public URL the provider routes to the workstation
   * @param name exact workstation name
   * @returns absolute URL
   */
  readUrl(name: string): Promise<string>;
}

/** the dotenv credential each live provider requires, as its catalog prerequisites declare */
export const LIVE_PROVIDER_CREDENTIALS = {
  sprite: catalog.providers.sprite.prerequisites.credential.environment,
};

const NOT_FOUND_STATUS = 404;
const SERVER_ERROR_STATUS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_RETRY_MS = 5_000;

/**
 * narrows a provider name supplied through the environment
 * @param name requested provider
 * @returns true for a supported provider
 */
export function isLiveProviderName(name: string): name is LiveProviderName {
  return Object.hasOwn(LIVE_PROVIDER_CREDENTIALS, name);
}

/**
 * creates the provider adapter for the selected live run
 * @param name selected provider
 * @param values parsed dotenv values holding the provider credential
 * @returns provider adapter
 */
export function createLiveProvider(
  name: LiveProviderName,
  values: Record<string, string>,
): LiveProvider {
  const credential = LIVE_PROVIDER_CREDENTIALS[name];
  const token = values[credential]?.trim();
  if (!token) {
    throw new Error(`${credential} is required in the live dotenv file`);
  }

  return createSpriteProvider(token);
}

/**
 * adapts the Fly Sprites SDK to the live provider contract
 * @param token Sprites management token
 * @returns Sprite provider adapter
 */
function createSpriteProvider(token: string): LiveProvider {
  const client = new SpritesClient(token, { timeout: REQUEST_TIMEOUT_MS });

  // a lookup changes nothing, so a transient management API failure is retried
  const lookup = async (name: string): Promise<Sprite> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.getSprite(name);
      } catch (error) {
        if (attempt >= LOOKUP_ATTEMPTS || !isTransient(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, LOOKUP_RETRY_MS));
      }
    }
  };

  const execute = async (name: string, script: string): Promise<string> => {
    const sprite = await lookup(name);
    const result = await sprite.execFile('/bin/sh', ['-c', script], {
      timeout: REQUEST_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Guest script exited ${result.exitCode}`);
    }

    return String(result.stdout);
  };

  return {
    name: 'sprite',
    createArgs: [],
    async listWorkstations(prefix) {
      const sprites = await client.listAllSprites(prefix);

      return sprites
        .map((sprite) => sprite.name)
        .filter((name) => name.startsWith(prefix));
    },
    async hasWorkstation(name) {
      return lookup(name).then(
        (sprite) => sprite.name === name,
        (error: unknown) => {
          if (
            error instanceof APIError &&
            error.statusCode === NOT_FOUND_STATUS
          ) {
            return false;
          }
          throw error;
        },
      );
    },
    execute,
    async inspectIdentity(name) {
      const sprite = await lookup(name);
      const listing = await execute(
        name,
        'find /opt /etc/cron.d /home/agent/.config /var/lock -mindepth 1 -maxdepth 1',
      );

      return {
        labels: sprite.labels,
        guestPaths: listing.split('\n').filter(Boolean),
        schedule: await execute(name, 'cat /etc/cron.d/open-agent'),
      };
    },
    async snapshotServices(name) {
      const sprite = await lookup(name);

      return (await sprite.listServices())
        .map((service) => ({
          name: service.name,
          status: service.state?.status ?? 'unknown',
          needs: service.needs,
          pid: service.state?.pid,
          startedAt: service.state?.startedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async readRunState(name) {
      const { status, lastRunningAt, lastWarmingAt } = await lookup(name);
      if (!status || !lastRunningAt) {
        return undefined;
      }

      return {
        status,
        lastRunningAt: new Date(lastRunningAt).toISOString(),
        lastWarmingAt: lastWarmingAt
          ? new Date(lastWarmingAt).toISOString()
          : undefined,
      };
    },
    async readUrl(name) {
      const { url } = await lookup(name);
      if (!url) {
        throw new Error(`${name} has no public URL`);
      }

      return url;
    },
    async deleteWorkstation(name, runId) {
      const sprite = await lookup(name);
      assertOwnedWorkstation(
        { name: sprite.name, labels: sprite.labels },
        { name, runId, label: MANAGED_LABEL },
      );
      await client.deleteSprite(name);
    },
  };
}

/**
 * tells whether a management API failure may pass on its own: a server
 * error, or a request that never got an answer
 * @param error what the SDK threw
 * @returns true when a retry may succeed
 */
function isTransient(error: unknown): boolean {
  return error instanceof APIError
    ? (error.statusCode ?? SERVER_ERROR_STATUS) >= SERVER_ERROR_STATUS
    : error instanceof Error;
}
