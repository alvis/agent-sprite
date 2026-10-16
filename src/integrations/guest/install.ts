import { CommandFault } from '#errors';
import { publishStatus, traceStage } from '#operation';
import { installProviderServices } from '#services/provider';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import {
  readGuestEnvironment,
  writeGuestEnvironment,
} from './environment-store.js';
import { assemblePlan } from './plan/assemble.js';
import { runPlan } from './plan/plan.js';
import {
  bottleProbe,
  HOMEBREW_STEP,
  refusedBottles,
} from './plan/steps/homebrew.js';

import type { Interaction } from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type { ProviderDriver } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { SetupConnection } from './connection.js';
import type { GuestEnvironment } from './environment.js';
import type { AssemblyParams, SetupAssembly } from './plan/assemble.js';
import type { PlanProgress, SetupStep } from './plan/contracts.js';

/** longest the bottle probe runs when it names no limit of its own */
const PROBE_LIMIT_MS = 300_000;

/** what a workstation is installed with */
export interface InstallParams {
  /** the provider the workstation runs on */
  provider: ProviderDriver;
  /** the root setup session the plan runs in */
  connection: SetupConnection;
  /** the profile setup applies */
  profile: WorkstationProfile;
  /** the environment an earlier setup recorded, whose device identity and services carry over */
  previous?: GuestEnvironment;
  /** receives each step's progress */
  interaction?: Interaction;
  /**
   * runs once the tools and environment.json are in place and before any
   * service or job starts, such as the network enrolment and native
   * configuration the agent's launcher reads only as it starts
   */
  beforeServices?: (guest: GuestChannel) => Promise<void>;
}

/**
 * installs a workstation through its setup plan: the foundation runs first
 * where Homebrew is needed, so the installed Homebrew can tell which formulae
 * have no bottle and those tools fall through to their next source, then the
 * whole plan runs, then what the caller runs before the services, then the
 * backend's services and jobs; services a provider runs itself are
 * registered last. The environment.json the plan writes stays `incomplete`
 * until {@link markInstallationReady}
 * @param params the provider, session, profile, previous record, progress and what runs before the services
 * @returns the environment the plan recorded
 * @throws {CommandFault} when a required tool has no usable source, or a critical step failed
 */
export async function installWorkstation(
  params: InstallParams,
): Promise<GuestEnvironment> {
  const { provider, connection, previous } = params;
  await connection.open();
  const base: AssemblyParams = {
    provider,
    profile: params.profile,
    release: connection.release,
    version: OPEN_AGENT_VERSION,
    setupAt: new Date().toISOString(),
    ...(previous?.networkIdentity && {
      networkIdentity: previous.networkIdentity,
    }),
  };
  const assembly = await bottledAssembly(params, base);
  await runSteps(params, [...assembly.foundation, ...assembly.steps]);
  await params.beforeServices?.(await connection.guest());
  await runSteps(params, assembly.services);
  if (provider.serviceBackend === 'provider') {
    await traceStage('setup.services', async () =>
      installProviderServices(
        (await connection.guest()).services,
        assembly.environment.services,
        previous?.services.map(({ name }) => name) ?? [],
      ),
    );
  }

  return assembly.environment;
}

/**
 * records a finished installation as ready: the record is read back so a
 * device identity enrolment recorded since the plan wrote it is kept
 * @param guest target guest
 */
export async function markInstallationReady(
  guest: GuestChannel,
): Promise<void> {
  const environment = await readGuestEnvironment(guest);
  await writeGuestEnvironment(guest, {
    ...environment,
    openAgent: {
      version: OPEN_AGENT_VERSION,
      setupAt: new Date().toISOString(),
    },
    setup: { ...environment.setup, state: 'ready' },
  });
}

/**
 * assembles the plan, and where it installs Homebrew, runs the foundation and
 * assembles again without the formulae Homebrew has no bottle of
 * @param params the session and progress
 * @param base what the plan is assembled from
 * @returns the plan to run
 */
async function bottledAssembly(
  params: InstallParams,
  base: AssemblyParams,
): Promise<SetupAssembly> {
  const assembly = await assemblePlan(base);
  const probe = bottleProbe(assembly.family, assembly.resolutions);
  if (!probe || !assembly.foundation.some(({ id }) => id === HOMEBREW_STEP)) {
    return assembly;
  }
  await runSteps(params, assembly.foundation);
  const { exitCode, stdout, stderr } = await params.connection.run({
    ...probe,
    account: 'root',
    timeoutMs: probe.timeoutMs ?? PROBE_LIMIT_MS,
  });
  if (exitCode !== 0) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Homebrew could not report which formulae have a bottle',
      details: stderr.trim() ? [stderr.trim()] : [],
    });
  }
  const refused = refusedBottles(stdout, assembly.resolutions);

  return refused.length > 0
    ? assemblePlan({ ...base, refused: [...(base.refused ?? []), ...refused] })
    : assembly;
}

/**
 * runs steps in the connection's session, reporting each step's progress
 * @param params the session and progress
 * @param steps setup steps, run in dependency order
 * @throws {CommandFault} when a critical step failed
 */
async function runSteps(
  params: Pick<InstallParams, 'connection' | 'interaction'>,
  steps: readonly SetupStep[],
): Promise<void> {
  const { connection, interaction } = params;
  const report = await traceStage('setup.plan', async () =>
    runPlan({
      steps,
      openSession: async (supersedes) => connection.lend(supersedes),
      onProgress: (event) => {
        reportProgress(event, interaction);
      },
    }),
  );
  if (!report.isComplete) {
    const failed = report.steps.filter(
      ({ status, step }) => status === 'failed' && step.critical,
    );
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Guest setup failed at ${failed.map(({ step }) => step.id).join(', ') || 'a critical step'}`,
      details: failed.map(
        ({ step, reason }) => `${step.id}: ${reason ?? 'failed'}`,
      ),
    });
  }
}

/**
 * reports a plan event as progress to the interaction, or, without one, as a
 * status line, so a non-interactive run streams each step too
 * @param event the plan event
 * @param interaction the prompts and progress display, when interactive
 */
function reportProgress(event: PlanProgress, interaction?: Interaction): void {
  const update = progressUpdate(event);
  if (interaction) {
    interaction.progress(update);

    return;
  }
  publishStatus({
    kind: update.outcome === 'failed' ? 'warning' : 'info',
    message: update.message,
  });
}

/**
 * describes a plan event as a progress update
 * @param event the plan event
 * @returns the update, staged by the step's component
 */
function progressUpdate(
  event: PlanProgress,
): Parameters<Interaction['progress']>[0] {
  switch (event.kind) {
    case 'step-started':
      return {
        stage: event.step.component,
        message: `Setting up ${event.step.id}`,
        phase: 'start',
      };
    case 'step-retrying':
      return {
        stage: event.step.component,
        message: `Retrying ${event.step.id} after the connection was lost`,
      };
    default: {
      const { step, status } = event.outcome;

      return {
        stage: step.component,
        message: `${step.id}: ${status}`,
        phase: 'complete',
        outcome: status === 'failed' ? 'failed' : 'ok',
      };
    }
  }
}
