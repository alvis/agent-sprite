import { guestAsset } from '#guest/assets';
import { ENVIRONMENT_PATH } from '#integrations/guest/environment';
import { libraryCommand } from '#integrations/guest/plan/steps/library';
import { ROOT_ONLY_MODE } from '#os/contracts';
import { familyOf } from '#os/families';
import { isRecord } from '#utilities/guards';

import { jobsStep } from '../cron.js';

import type {
  GuestServiceControl,
  GuestServiceState,
  ServiceDefinition,
} from '#drivers/guest-channel';
import type {
  SetupStep,
  StepCommand,
} from '#integrations/guest/plan/contracts';
import type { LibraryCall } from '#integrations/guest/plan/steps/library';
import type { GuestSession } from '#integrations/guest/session/contracts';
import type { ServiceBackend, ServiceStepContext } from '#os/contracts';
import type { ToolSpec } from '#tools/contracts';

/** the runit helpers: write, start, stop and list each service environment.json records */
export const RUNIT_LIBRARY = guestAsset(
  'os/services/runit/lib.sh',
  ROOT_ONLY_MODE,
);

/** id of the step that installs and starts the services */
export const SERVICES_STEP = 'services:runit';

/** longest installing and starting every service may take; each start waits up to 30 seconds */
const SERVICES_LIMIT_MS = 300_000;
/** longest one control command may take: a start or stop waits up to 30 seconds, a removal twice that */
const CONTROL_LIMIT_MS = 90_000;
/** the exit of `oa_sv_stop` for a service open-agent did not install */
const NOT_INSTALLED = 2;
/** every status a listed service can report */
const STATUSES: ReadonlySet<unknown> = new Set([
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
]);

/**
 * runit, the supervisor of a guest whose provider runs no services itself;
 * Homebrew's formula first, the distribution's package where none is poured
 */
export const RUNIT_TOOL: ToolSpec = {
  name: 'runit',
  required: true,
  executables: ['chpst', 'runsv', 'runsvdir', 'sv', 'svlogd'],
  // runit reports no version, so the probe checks every command it ships
  version: {
    executable: 'sh',
    args: [
      '-c',
      'for oa_command in chpst runsv runsvdir sv svlogd; do command -v "$oa_command" || exit 1; done',
    ],
    account: 'root',
  },
  sources: [
    { kind: 'brew', formula: 'runit' },
    // the package's own unit would start a second runsvdir under systemd
    {
      kind: 'system',
      family: 'debian',
      packages: ['runit'],
      vendorServices: ['runit.service'],
    },
  ],
};

/**
 * the runit backend: every service environment.json records is a service
 * directory runsvdir supervises, and the boot hook starts runsvdir
 */
export const runitBackend: ServiceBackend = {
  id: 'runit',
  tools: [RUNIT_TOOL],
  library: RUNIT_LIBRARY,
  steps: (context) => [servicesStep(context), jobsStep(context)],
  control: (session) => new RunitServiceControl(session),
};

/**
 * builds the step that installs every service environment.json records,
 * removes those it no longer records, and starts each; it is in place once
 * each is installed as defined and running
 * @param context the family and the steps that must succeed first
 * @returns the step that installs and starts the services, checking first whether they run as defined
 */
function servicesStep(context: ServiceStepContext): SetupStep {
  const command = (...calls: LibraryCall[]): StepCommand =>
    libraryCommand(context.family.shell, [RUNIT_LIBRARY], calls);

  return {
    id: SERVICES_STEP,
    component: 'runit',
    account: 'root',
    needs: [...context.needs],
    check: command(['oa_sv_check', ENVIRONMENT_PATH]),
    apply: command(
      ['oa_sv_install', ENVIRONMENT_PATH],
      ['oa_sv_start', ENVIRONMENT_PATH],
    ),
    verify: command(['oa_sv_check', ENVIRONMENT_PATH]),
    timeoutMs: SERVICES_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}

/** controls the runit services of a guest through its session, as root */
class RunitServiceControl implements GuestServiceControl {
  /** the guest's family shell, which sources the library */
  readonly #shell: string;

  /**
   * binds the control to a session
   * @param session the guest's root session
   */
  constructor(private readonly session: GuestSession) {
    this.#shell = familyOf(session.release).shell;
  }

  /**
   * reads every one of open-agent's services and its state
   * @returns the services
   * @throws {Error} when the listing fails or is malformed
   */
  public async list(): Promise<GuestServiceState[]> {
    const { stdout } = await this.#call('listing the services', ['oa_sv_list']);
    const states: unknown = JSON.parse(stdout);
    if (!Array.isArray(states) || !states.every(isServiceState)) {
      throw new Error('The guest reported a malformed service listing');
    }

    return states;
  }

  /**
   * installs a definition, restarting the service when it changed, and waits
   * for it to run
   * @param definition the service's command, account and needs
   */
  public async ensure(definition: ServiceDefinition): Promise<void> {
    await this.#call(`starting service ${definition.name}`, [
      'oa_sv_ensure',
      JSON.stringify(definition),
    ]);
  }

  /**
   * stops a service and waits for it to stop
   * @param name name of the service to stop
   * @returns false when it did not stop in time
   * @throws {Error} when open-agent installed no such service
   */
  public async stop(name: string): Promise<boolean> {
    const result = await this.session.run({
      argv: this.#argv(['oa_sv_stop', name]),
      timeoutMs: CONTROL_LIMIT_MS,
    });
    if (result.exitCode === NOT_INSTALLED) {
      throw new Error(`There is no service ${name} to stop`);
    }

    return result.exitCode === 0;
  }

  /**
   * stops and removes a service; one that is not installed is left alone
   * @param name name of the service to remove
   */
  public async remove(name: string): Promise<void> {
    await this.#call(`removing service ${name}`, ['oa_sv_remove', name]);
  }

  /**
   * runs one library call and fails unless it exits 0
   * @param action what the call does, for the error
   * @param call the function and its arguments
   * @returns its output
   * @throws {Error} when the call exits non-zero
   */
  async #call(action: string, call: LibraryCall): Promise<{ stdout: string }> {
    const result = await this.session.run({
      argv: this.#argv(call),
      timeoutMs: CONTROL_LIMIT_MS,
    });
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim() || `exit ${result.exitCode}`;

      throw new Error(`Failed ${action}: ${reason}`);
    }

    return result;
  }

  /**
   * renders one library call as a command of the family's shell
   * @param call the function and its arguments
   * @returns the command's argv
   */
  #argv(call: LibraryCall): readonly [string, ...string[]] {
    return libraryCommand(this.#shell, [RUNIT_LIBRARY], [call]).argv;
  }
}

/**
 * tells whether a listed entry is a service state
 * @param value the entry
 * @returns true when it has a name, a known status, its needs and an optional start time
 */
function isServiceState(value: unknown): value is GuestServiceState {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    STATUSES.has(value.status) &&
    Array.isArray(value.needs) &&
    value.needs.every((need) => typeof need === 'string') &&
    (value.startedAt === undefined || typeof value.startedAt === 'string')
  );
}
