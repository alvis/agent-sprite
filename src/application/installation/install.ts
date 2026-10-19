import { CommandFault } from '#kernel/faults';
import { traceStage } from '#kernel/operation';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { reportProgress } from './progress';

import type { ProviderDriver } from '#application/ports/drivers';
import type { GuestMechanics } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type {
  AssemblyParams,
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

/**
 * installs a workstation through its setup plan: the foundation runs first
 * where Homebrew is needed, so the installed Homebrew can tell which formulae
 * have no bottle and those tools fall through to their next source, then the
 * whole plan runs, then what the caller runs before the services, then the
 * backend's services and jobs; services a provider runs itself are
 * registered last. The environment.json the plan writes stays `incomplete`
 * until the caller marks the installation ready
 * @param mechanics the guest's plan and provider services
 * @param params the provider, session, profile, previous record, progress and what runs before the services
 * @returns the environment the plan recorded
 * @throws {CommandFault} when a required tool has no usable source, or a critical step failed
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
    ...(previous?.networkIdentity && {
      networkIdentity: previous.networkIdentity,
    }),
  };
  const assembly = await bottledAssembly(mechanics, params, base);
  await runSteps(mechanics, params, [
    ...assembly.foundation,
    ...assembly.steps,
  ]);
  await params.beforeServices?.(await connection.guest());
  await runSteps(mechanics, params, assembly.services);
  if (provider.serviceBackend === 'provider') {
    await traceStage('setup.services', async () =>
      mechanics.services.installProvider({
        control: (await connection.guest()).services,
        services: assembly.environment.services,
        previous: previous?.services.map(({ name }) => name) ?? [],
      }),
    );
  }

  return assembly.environment;
}

/**
 * assembles the plan, and where it installs Homebrew, runs the foundation and
 * assembles again without the formulae Homebrew has no bottle of
 * @param mechanics the guest's plan
 * @param params the session and progress
 * @param base what the plan is assembled from
 * @returns the plan to run
 */
async function bottledAssembly(
  mechanics: Pick<GuestMechanics, 'plan'>,
  params: InstallParams,
  base: AssemblyParams,
): Promise<SetupAssembly> {
  const { plan } = mechanics;
  const assembly = await plan.assemble(base);
  if (!plan.needsBottleProbe(assembly)) {
    return assembly;
  }
  await runSteps(mechanics, params, assembly.foundation);
  const refused = await plan.probeBottles(params.connection, assembly);

  return refused.length > 0
    ? plan.assemble({ ...base, refused: [...(base.refused ?? []), ...refused] })
    : assembly;
}

/**
 * runs steps in the connection's session, reporting each step's progress
 * @param mechanics the guest's plan
 * @param params the session and progress
 * @param steps setup steps, run in dependency order
 * @throws {CommandFault} when a critical step failed
 */
async function runSteps(
  mechanics: Pick<GuestMechanics, 'plan'>,
  params: Pick<InstallParams, 'connection' | 'interaction'>,
  steps: readonly SetupStep[],
): Promise<void> {
  const { connection, interaction } = params;
  const report = await traceStage('setup.plan', async () =>
    mechanics.plan.run({
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
