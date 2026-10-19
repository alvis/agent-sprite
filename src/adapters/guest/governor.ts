import {
  AWAKE_COMMAND,
  AWAKE_DEADLINE_MS,
} from '#adapters/guest/platform/awake';
import { runGuestResult } from '#adapters/guest/platform/run';
import { isGovernorReport } from '#domain/observations/governor';
import { checkOperation } from '#kernel/operation';

import type { AwakeAction } from '#adapters/guest/platform/awake';
import type { ProviderDriver } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { ServiceStepContext } from '#application/ports/os';
import type { SetupStep, StepCommand } from '#application/ports/plan';
import type {
  SessionAwakeHold,
  SessionCommand,
} from '#application/ports/session';
import type { ProviderCapabilities } from '#domain/declarations';
import type { GovernorReport } from '#domain/observations/governor';
import type { ServiceDefinition, PeriodicJob } from '#domain/services';

/** id of the step that makes the governor's directories */
export const IDLE_STEP = 'governor:directories';

/** the source a session's managed hold is recorded under */
const SESSION_HOLD_SOURCE = 'session';

/** time, in milliseconds, a hold command gets to start beyond its event's budget */
const HOLD_SLACK_MS = 2_000;

/** longest a hold command runs */
const HOLD_LIMIT_MS = AWAKE_DEADLINE_MS + HOLD_SLACK_MS;

/** longest one command of the directories step may take */
const IDLE_STEP_LIMIT_MS = 30_000;

/** longest the governor report may take */
const REPORT_LIMIT_MS = 30_000;

/**
 * the relay of awake events into the machine's log, root's service on a
 * backend that has such a log: it validates the one-line records the events
 * leave on memory-backed storage and writes each as a line of that log, so
 * what an event as the agent says reaches the log only as fields root checked
 */
export const awakeRelayService: ServiceDefinition = {
  name: 'open-agent-awake-relay',
  command: AWAKE_COMMAND,
  arguments: ['relay'],
  account: 'root',
  needs: [],
  machineLog: true,
};

/**
 * lists the services the idle governor needs: the awake events' relay where
 * the service backend is runit, whose machine log it writes to; a backend
 * the provider runs the services on needs none
 * @param provider the provider's service backend
 * @returns the relay, or none
 */
export function governorServices(
  provider: Pick<ProviderDriver, 'serviceBackend'>,
): ServiceDefinition[] {
  return provider.serviceBackend === 'runit' ? [awakeRelayService] : [];
}

/**
 * lists the periodic jobs the idle governor needs: a governed provider's
 * per-minute root tick, which puts the workstation into its idle form once
 * the deadline passed; any other provider needs none
 * @param capabilities whether the provider governs its keep-awake
 * @returns the tick job, or none
 */
export function governorJobs(
  capabilities: Pick<ProviderCapabilities, 'keepAwakeMode'>,
): PeriodicJob[] {
  return capabilities.keepAwakeMode === 'governed'
    ? [
        {
          name: 'governor-tick',
          everyMinutes: 1,
          run: { command: AWAKE_COMMAND, arguments: ['tick'], account: 'root' },
        },
      ]
    : [];
}

/**
 * renders a managed hold command keyed by a session shell's pid, which the
 * governor drops once the shell is gone
 * @param action whether the hold opens or closes
 * @param pid the session shell's pid
 * @returns the command, run as root
 */
function holdCommand(
  action: Extract<AwakeAction, 'hold-open' | 'hold-close'>,
  pid: number,
): SessionCommand {
  return {
    argv: [
      AWAKE_COMMAND,
      action,
      '--source',
      SESSION_HOLD_SOURCE,
      '--session',
      `session-${pid}`,
      '--pid',
      String(pid),
    ],
    account: 'root',
    timeoutMs: HOLD_LIMIT_MS,
  };
}

/** holds the workstation awake while a session's shell lives */
export const sessionAwakeHold: SessionAwakeHold = {
  open: (pid) => holdCommand('hold-open', pid),
  close: (pid) => holdCommand('hold-close', pid),
};

/**
 * builds the step that makes the governor's directories: the run directory,
 * the agent's awake directory and root's, which the agent only reads
 * @param context the steps that must succeed first, such as the one installing the command
 * @returns the step, checking first whether the directories are in place
 */
export function idleStep(
  context: Pick<ServiceStepContext, 'needs'>,
): SetupStep {
  const command = (subcommand: string): StepCommand => ({
    argv: [AWAKE_COMMAND, subcommand],
  });

  return {
    id: IDLE_STEP,
    component: 'idle governor',
    account: 'root',
    needs: [...context.needs],
    check: command('check'),
    apply: command('install'),
    verify: command('check'),
    timeoutMs: IDLE_STEP_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}

/**
 * reads the idle governor's recorded state through root's `report`, which
 * reads the agent-writable record as untrusted data; the state is reported,
 * never a readiness failure, so an unreadable record becomes a reason
 * @param guest target guest
 * @returns the validated state, or why none could be read
 */
export async function inspectGovernor(
  guest: GuestChannel,
): Promise<GovernorReport> {
  try {
    const { exitCode, stdout } = await runGuestResult(
      guest,
      [AWAKE_COMMAND, 'report'],
      { timeoutMs: REPORT_LIMIT_MS },
    );
    const report: unknown = exitCode === 0 ? JSON.parse(stdout) : undefined;

    return isGovernorReport(report)
      ? report
      : { recorded: false, reason: 'the governor report is unavailable' };
  } catch {
    checkOperation();

    return { recorded: false, reason: 'the governor report is unavailable' };
  }
}
