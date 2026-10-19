import { APIError, SpritesClient } from '@fly/sprites';

import { registry } from '#composition/registry';
import { MANAGED_LABEL, SCHEMA_LABEL } from '#adapters/drivers/providers/sprite/labels';

import { tail } from './cli';
import { createFlyInventory, flyMachineMetadata } from './fly';
import { TEST_PREFIX } from './identity';
import { assertOwnedWorkstation } from './ownership';

import type { Sprite } from '@fly/sprites';

import type { ProviderId } from '#domain/ids';

import type { Redactor } from './redaction';

/** a machine type: the provider the CLI creates the workstation on */
export type MachineType = ProviderId;

/** identifiers a workstation carries, as observed at the provider */
export interface WorkstationIdentity {
  /** provider labels attached to the workstation */
  labels: readonly string[];
  /** the labels every managed workstation of the provider carries */
  requiredLabels: readonly string[];
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
export interface MachineInventory {
  /** machine type whose provider account the inventory reads */
  readonly name: MachineType;
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
   * deletes directly through the provider after rechecking name, scope and label
   * @param name exact workstation name
   * @param scope cleanup scope that must contain the name
   */
  deleteWorkstation(name: string, scope: string): Promise<void>;
}

/** what a provider adapter acts with */
export interface MachineProviderOptions {
  /** the machine type's management credential */
  token: string;
  /** removes credential values from guest output before any test reads it */
  redact: Redactor;
}

/** out-of-band access to the workstations of one machine type */
export interface MachineProvider extends MachineInventory {
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
   * @returns the script's standard output, redacted
   * @throws {Error} with the exit code and the end of the redacted standard
   * error when the script exits non-zero
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
   * reads the expiry of the provider's own awake task, which the agent
   * account reaches without a credential
   * @param name exact workstation name
   * @returns the expiry, absent when the provider holds no such task
   */
  readAwakeTask(name: string): Promise<string | undefined>;
  /**
   * reads the public URL the provider routes to the workstation
   * @param name exact workstation name
   * @returns absolute URL
   */
  readUrl(name: string): Promise<string>;
}

/** the guest-local Sprite API socket and the awake task open-agent keeps there */
const SPRITE_SOCKET = '/.sprite/api.sock';
const AWAKE_TASK = 'open-agent-awake';
/** each runit service with the process id its runsv records, one per line */
const RUNIT_PIDS =
  'cd /etc/service && for service in *; do printf "%s %s\\n" "$service" "$(cat "$service/supervise/pid" 2>/dev/null)"; done';
/** the prefix of the metadata keys Fly itself sets on a machine */
const FLY_METADATA_PREFIX = 'fly_';
/** the ownership and schema keys every managed Fly Machine carries */
const FLY_REQUIRED_LABELS = ['open-agent=managed', 'open-agent-schema=1'];
const NOT_FOUND_STATUS = 404;
const SERVER_ERROR_STATUS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_RETRY_MS = 5_000;

/**
 * the variable holding the management credential of a machine type, as its
 * catalog prerequisites declare, with the e2e prefix
 * @param type machine type
 * @returns `TEST_` and the credential's environment name
 */
export function credentialVariable(type: MachineType): string {
  return `${TEST_PREFIX}${registry.providers[type].prerequisites.credential.environment}`;
}

/**
 * creates the provider adapter of a machine type
 * @param type the provider the adapter drives
 * @param options credential and redaction
 * @returns provider adapter
 */
export function createMachineProvider(
  type: MachineType,
  options: MachineProviderOptions,
): MachineProvider {
  return type === 'sprite'
    ? createSpriteProvider(options)
    : createFlyProvider(options);
}

/**
 * reads a guest script's result, so no test ever sees a credential the guest printed
 * @param result exit code and output of the script
 * @param result.exitCode the script's exit code
 * @param result.stdout its standard output
 * @param result.stderr its standard error
 * @param redact removes credential values
 * @returns the redacted standard output
 * @throws {Error} with the exit code and the end of the redacted standard
 * error when the script failed
 */
function guestOutput(
  result: {
    exitCode: number;
    stdout: string | Buffer;
    stderr: string | Buffer;
  },
  redact: Redactor,
): string {
  if (result.exitCode !== 0) {
    throw new Error(
      `Guest script exited ${result.exitCode}: ${redact(tail(String(result.stderr)))}`,
    );
  }

  return redact(String(result.stdout));
}

/**
 * adapts the Fly Sprites SDK to the provider contract
 * @param options Sprites management token and redaction
 * @returns Sprite provider adapter
 */
function createSpriteProvider(
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
    name: 'sprite',
    /** @param prefix */
    async listWorkstations(prefix) {
      const sprites = await client.listAllSprites(prefix);

      return sprites
        .map((sprite) => sprite.name)
        .filter((name) => name.startsWith(prefix));
    },
    /** @param name */
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
    /** @param name */
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
    /** @param name */
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
    /** @param name */
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
    /** @param name */
    async readUrl(name) {
      const { url } = await lookup(name);
      if (!url) {
        throw new Error(`${name} has no public URL`);
      }

      return url;
    },
    /** @param name */
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
        tasks?: Array<{ name: string; expires_at: string }>;
      };

      return reply.tasks?.find((task) => task.name === AWAKE_TASK)?.expires_at;
    },
    /**
     * @param name
     * @param scope
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
 * adapts the Fly Machines API and the product's own Fly Machine driver, whose
 * guest channel reaches the machine as root, to the provider contract
 * @param options Fly organization token and redaction
 * @returns Fly Machine provider adapter
 */
function createFlyProvider(options: MachineProviderOptions): MachineProvider {
  const { token, redact } = options;
  const inventory = createFlyInventory(token);
  const driver = registry.providers['fly-machine'].authenticate({
    credential: token,
    restorableServices: [],
  });
  const execute = async (name: string, script: string): Promise<string> => {
    const channel = await driver.openGuest(await driver.get(name));
    const result = await channel.exec({
      program: '/bin/sh',
      arguments: ['-c', script],
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    return guestOutput(result, redact);
  };

  return {
    ...inventory,
    name: 'fly-machine',
    execute,
    /** @param name */
    async inspectIdentity(name) {
      const metadata = await flyMachineMetadata(token, name);
      const listing = await execute(
        name,
        'find /opt /etc/cron.d /home/agent/.config /var/lock -mindepth 1 -maxdepth 1',
      );

      return {
        // Fly's own keys are the platform's, not identifiers of a product
        labels: Object.entries(metadata)
          .filter(([key]) => !key.startsWith(FLY_METADATA_PREFIX))
          .map(([key, value]) => `${key}=${value}`),
        requiredLabels: FLY_REQUIRED_LABELS,
        guestPaths: listing.split('\n').filter(Boolean),
        schedule: await execute(name, 'cat /etc/cron.d/open-agent'),
      };
    },
    /** @param name */
    async snapshotServices(name) {
      const channel = await driver.openGuest(await driver.get(name));
      const services = await channel.services.list();
      // the service state carries no process id; runsv records it beside each service
      const pids = new Map(
        (await execute(name, RUNIT_PIDS))
          .split('\n')
          .map((line) => line.split(' '))
          .flatMap(([service, pid]) =>
            service && pid ? [[service, Number(pid)] as const] : [],
          ),
      );

      return services
        .map((service) => ({
          name: service.name,
          status: service.status ?? 'unknown',
          needs: [...service.needs],
          pid: pids.get(service.name),
          startedAt: service.startedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    /** @param name */
    async readRunState(name) {
      const { state } = await driver.get(name);

      // the Machines API reports the state alone, without transition times
      return {
        status: state,
        lastRunningAt: undefined,
        lastWarmingAt: undefined,
      };
    },
    // a Fly Machine keeps no awake task: the idle governor alone decides
    readAwakeTask: async () => undefined,
    /** @param name */
    async readUrl(name) {
      const { url } = await driver.get(name);
      if (!url) {
        throw new Error(`${name} has no public URL`);
      }

      return url;
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
