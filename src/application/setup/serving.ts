import {
  ReadinessFault,
  assessReadiness,
  servedVersionMismatch,
} from '#application/readiness';
import { inspectUntilServing } from '#application/serving';
import { agentPort } from '#domain/services';
import { traceStage } from '#kernel/operation';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';

import type { SetupContext } from './context';

/**
 * waits for the restarted agent service to serve, then exposes it; a
 * workstation that is not ready, or whose agent serves another version than
 * the one installed, is never exposed
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context provider, workstation and the selection this run applies
 * @throws {ReadinessFault} when the workstation is not ready once the agent serves, or the agent serves another version than the one installed
 */
export async function exposeWhenServing(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: Pick<SetupContext, 'provider' | 'workstation' | 'profile'>,
): Promise<void> {
  const inspection = await traceStage('setup.readiness', async () =>
    inspectUntilServing(
      async () =>
        dependencies.guest.native.inspectAgentEnvironment(
          guest,
          context.profile.agent,
        ),
      async () => dependencies.guest.inspection.inspect(guest),
    ),
  );
  const readiness = assessReadiness(dependencies, inspection);
  const mismatch = servedVersionMismatch(dependencies, inspection);
  if (!readiness.ready || mismatch) {
    throw new ReadinessFault({
      ...readiness,
      ready: false,
      failures: [...readiness.failures, ...(mismatch ? [mismatch] : [])],
    });
  }
  await context.provider.expose(
    context.workstation,
    agentPort(dependencies.registry, context.profile.agent),
    'public',
  );
}
