import { agentPort } from '#core/services';
import { inspectGuest } from '#integrations/guest/runtime';
import { inspectAgentEnvironment } from '#integrations/native';
import { traceStage } from '#operation';
import { ReadinessFault, assessReadiness } from '#readiness';
import { inspectUntilServing } from '#serving';

import type { GuestChannel } from '#drivers/guest-channel';

import type { SetupContext } from './context.js';

/**
 * waits for the restarted agent service to serve, then exposes it; a
 * workstation that is not ready is never exposed
 * @param guest guest channel of the managed workstation
 * @param context provider, workstation and the selection this run applies
 * @throws {ReadinessFault} when the workstation is not ready once the agent serves
 */
export async function exposeWhenServing(
  guest: GuestChannel,
  context: Pick<SetupContext, 'provider' | 'workstation' | 'profile'>,
): Promise<void> {
  const inspection = await traceStage('setup.readiness', async () =>
    inspectUntilServing(
      async () => inspectAgentEnvironment(guest, context.profile.agent),
      async () => inspectGuest(guest),
    ),
  );
  const readiness = assessReadiness(inspection);
  if (!readiness.ready) {
    throw new ReadinessFault(readiness);
  }
  await context.provider.expose(
    context.workstation,
    agentPort(context.profile.agent),
    'public',
  );
}
