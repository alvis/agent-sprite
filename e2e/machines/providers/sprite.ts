import { APIError, SpritesClient } from '@fly/sprites';

import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
} from '#adapters/drivers/providers/sprite/labels';

import { assertOwnedWorkstation } from '../ownership';

import { REQUEST_TIMEOUT_MS } from './limits';
import { guestOutput } from './output';

import type { Sprite } from '@fly/sprites';

import type { MachineProvider, MachineProviderOptions } from '../providers';

type SpriteLookup = (name: string) => Promise<Sprite>;

const SPRITE_SOCKET = '/.sprite/api.sock';
const AWAKE_TASK = 'open-agent-awake';
const NOT_FOUND_STATUS = 404;
const SERVER_ERROR_STATUS = 500;
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_RETRY_MS = 5_000;

/**
 * adapts the Fly Sprites SDK to the provider contract
 * @param options Sprites management token and redaction
 * @returns Sprite provider adapter
 */
export function createSpriteProvider(
  options: MachineProviderOptions,
): MachineProvider {
  const { token, redact } = options;
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

    return guestOutput(result, redact);
  };

  return {
    ...spriteInventory(client, lookup),
    ...spriteGuest(lookup, execute),
    ...spriteState(lookup, execute),
    execute,
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

/**
 * supplies Sprite listing, presence, and owned deletion
 * @param client management API client
 * @param lookup retrying read-only lookup
 * @returns inventory operations
 */
function spriteInventory(
  client: SpritesClient,
  lookup: SpriteLookup,
): Pick<
  MachineProvider,
  'name' | 'listWorkstations' | 'hasWorkstation' | 'deleteWorkstation'
> {
  return {
    name: 'sprite',
    /**
     * lists Sprites whose names match the run's prefix
     * @param prefix run-scoped workstation name prefix
     * @returns matching workstation names
     */
    async listWorkstations(prefix) {
      const sprites = await client.listAllSprites(prefix);

      return sprites
        .map((sprite) => sprite.name)
        .filter((name) => name.startsWith(prefix));
    },
    /**
     * checks whether the named Sprite still exists
     * @param name exact workstation name
     * @returns true when the provider finds the Sprite
     */
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
    /**
     * deletes an owned Sprite after validating its provider labels
     * @param name exact workstation name
     * @param scope run-scoped workstation name prefix
     * @returns when deletion completes
     */
    async deleteWorkstation(name, scope) {
      const sprite = await lookup(name);
      assertOwnedWorkstation(
        { name: sprite.name, labels: sprite.labels },
        { name, scope, label: MANAGED_LABEL },
      );
      await client.deleteSprite(name);
    },
  };
}

/**
 * observes managed identity and supervised services inside a Sprite
 * @param lookup retrying read-only lookup
 * @param execute redacted guest shell execution
 * @returns guest inspection operations
 */
function spriteGuest(
  lookup: SpriteLookup,
  execute: MachineProvider['execute'],
): Pick<MachineProvider, 'inspectIdentity' | 'snapshotServices'> {
  return {
    /**
     * reads the Sprite's managed labels and guest state paths
     * @param name exact workstation name
     * @returns provider identity and guest state paths
     */
    async inspectIdentity(name) {
      const sprite = await lookup(name);
      const listing = await execute(
        name,
        'find /opt /etc/cron.d /home/agent/.config /var/lock -mindepth 1 -maxdepth 1',
      );

      return {
        labels: sprite.labels,
        requiredLabels: [MANAGED_LABEL, SCHEMA_LABEL],
        guestPaths: listing.split('\n').filter(Boolean),
        schedule: await execute(name, 'cat /etc/cron.d/open-agent'),
      };
    },
    /**
     * lists the Sprite's supervised services and process details
     * @param name exact workstation name
     * @returns ordered service process snapshots
     */
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
  };
}

/**
 * observes run state, public URL, and the native awake task
 * @param lookup retrying read-only lookup
 * @param execute redacted guest shell execution
 * @returns state inspection operations
 */
function spriteState(
  lookup: SpriteLookup,
  execute: MachineProvider['execute'],
): Pick<MachineProvider, 'readRunState' | 'readUrl' | 'readAwakeTask'> {
  return {
    /**
     * reads the Sprite's current run state and transition times
     * @param name exact workstation name
     * @returns run state, or nothing before the first running transition
     */
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
    /**
     * reads the Sprite's public URL
     * @param name exact workstation name
     * @returns public URL
     */
    async readUrl(name) {
      const { url } = await lookup(name);
      if (!url) {
        throw new Error(`${name} has no public URL`);
      }

      return url;
    },
    /**
     * reads the managed awake task expiry from the Sprite socket
     * @param name exact workstation name
     * @returns expiry timestamp when the task exists
     */
    async readAwakeTask(name) {
      // curl -s prints nothing when the socket does not answer
      const text = (
        await execute(
          name,
          `/usr/bin/sudo -n runuser -u agent -- curl -s --max-time 5 --unix-socket ${SPRITE_SOCKET} http://sprite/v1/tasks`,
        )
      ).trim();
      if (text === '') {
        throw new Error(
          `The Sprite API socket ${SPRITE_SOCKET} of ${name} answered the task listing with nothing`,
        );
      }
      const reply = JSON.parse(text) as {
        tasks?: Array<{ name: string } & Record<'expires_at', string>>;
      };
      const { expires_at: expiresAt } =
        reply.tasks?.find((task) => task.name === AWAKE_TASK) ?? {};

      return expiresAt;
    },
  };
}
