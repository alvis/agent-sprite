import { isDeepStrictEqual } from 'node:util';

import { CommandFault } from '#kernel/faults';
import { traceStage } from '#kernel/operation';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { reportProgress } from './installation/progress';

import type { ProviderDriver } from '#application/ports/drivers';
import type { GuestMechanics } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type {
  AssemblyParams,
  PlanReport,
  PlanRunParams,
  SetupAssembly,
  SetupStep,
} from '#application/ports/plan';
import type { SetupSession } from '#application/ports/session';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { WorkstationProfile } from '#domain/profile';

/** what a workstation is installed with */
export interface InstallParams {
  /** the provider the workstation runs on */
  provider: ProviderDriver;
  /** the root setup session the plan runs in */
  connection: SetupSession;
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

/** a plan assembled for the run, with the foundation steps already run to success in its session */
interface BottledAssembly {
  /** the plan to run */
  assembly: SetupAssembly;
  /** the foundation steps the first run settled that the plan declares unchanged */
  settled: readonly string[];
}

/**
 * installs a workstation through its setup plan: the foundation runs first
 * where Homebrew is needed, so the installed Homebrew can tell which formulae
 * have no bottle and those tools fall through to their next source, then the
 * whole plan runs, without the foundation steps that first run settled and
 * the plan left unchanged, then what the caller runs before the services, then the
 * backend's services and jobs; services a provider runs itself are
 * registered last. The environment.json the plan writes stays `incomplete`
 * until the caller marks the installation ready
 * @param mechanics the guest's plan and provider services
 * @param params the provider, session, profile, previous record, progress and what runs before the services
 * @returns the environment the plan recorded
 */
export async function installWorkstation(
  mechanics: Pick<GuestMechanics, 'plan' | 'services'>,
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
    networkIdentity: previous?.networkIdentity,
  };
  const { assembly, settled } = await bottledAssembly(mechanics, params, base);
  await runSteps(mechanics, params, {
    steps: [
      ...assembly.foundation.filter(({ id }) => !settled.includes(id)),
      ...assembly.steps,
    ],
    settled,
  });
  await params.beforeServices?.(await connection.guest());
  await runSteps(mechanics, params, { steps: assembly.services });
  if (provider.serviceBackend === 'provider') {
    await traceStage({
      stage: 'setup.services',
      action: async () =>
        mechanics.services.installProvider({
          control: (await connection.guest()).services,
          services: assembly.environment.services,
          previous: previous?.services.map(({ name }) => name) ?? [],
        }),
    });
  }

  return assembly.environment;
}

/**
 * assembles the plan, and where it installs Homebrew, runs the foundation and
 * assembles again without the formulae Homebrew has no bottle of
 * @param mechanics the guest's plan
 * @param params the session and progress
 * @param base what the plan is assembled from
 * @returns the plan to run and the foundation steps already settled
 */
async function bottledAssembly(
  mechanics: Pick<GuestMechanics, 'plan'>,
  params: InstallParams,
  base: AssemblyParams,
): Promise<BottledAssembly> {
  const { plan } = mechanics;
  const assembly = await plan.assemble(base);
  if (!plan.needsBottleProbe(assembly)) {
    return { assembly, settled: [] };
  }
  const first = await runSteps(mechanics, params, {
    steps: assembly.foundation,
  });
  const refused = await plan.probeBottles(params.connection, assembly);
  const bottled =
    refused.length > 0
      ? await plan.assemble({
          ...base,
          refused: [...(base.refused ?? []), ...refused],
        })
      : assembly;

  return {
    assembly: bottled,
    settled: settledSteps(bottled.foundation, first),
  };
}

/**
 * names the foundation steps a first run left in place that need not run
 * again: each ended satisfied or applied, the plan declares it unchanged, and
 * every step it needs is settled too, so a step whose definition or need
 * changed runs again. A step that sends a credential is unchanged only as the
 * very same step, since a credential's value is never compared
 * @param foundation the foundation of the plan to run
 * @param first the first run's report, in the order its steps ran
 * @returns the settled steps' identifiers
 */
function settledSteps(
  foundation: readonly SetupStep[],
  first: PlanReport,
): string[] {
  const current = new Map(foundation.map((step) => [step.id, step]));
  const settled: string[] = [];
  for (const { step, status } of first.steps) {
    const declared = current.get(step.id);
    const isUnchanged =
      declared === step ||
      (declared !== undefined &&
        !sendsSecret(step) &&
        isDeepStrictEqual(declared, step));
    if (
      isUnchanged &&
      (status === 'satisfied' || status === 'applied') &&
      step.needs.every((need) => settled.includes(need))
    ) {
      settled.push(step.id);
    }
  }

  return settled;
}

/**
 * tells whether a step sends a credential through one of its commands
 * @param step a foundation step of the plan
 * @returns true when its check, apply or verify takes a secret input
 */
function sendsSecret(step: SetupStep): boolean {
  return [step.check, step.apply, step.verify].some(
    (command) => command?.input?.kind === 'secret',
  );
}

/**
 * runs steps in the connection's session, reporting each step's progress
 * @param mechanics the guest's plan
 * @param params the session and progress
 * @param plan setup steps, run in dependency order, and the steps an earlier run in the session settled, which they may need
 * @returns every step's outcome
 * @throws {CommandFault} when a critical step failed
 */
async function runSteps(
  mechanics: Pick<GuestMechanics, 'plan'>,
  params: Pick<InstallParams, 'connection' | 'interaction'>,
  plan: Pick<PlanRunParams, 'steps' | 'settled'>,
): Promise<PlanReport> {
  const { connection, interaction } = params;
  const { steps, settled = [] } = plan;
  const report = await traceStage({
    stage: 'setup.plan',
    action: async () =>
      mechanics.plan.run({
        steps,
        settled,
        openSession: async (supersedes) => connection.lend(supersedes),
        onProgress: (event) => {
          reportProgress(event, interaction);
        },
      }),
  });
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

  return report;
}
