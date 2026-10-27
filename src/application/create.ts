import { agentPort } from '#domain/services';
import { traceStage } from '#kernel/operation';

import { creationOutcome, markCreateIncomplete } from './create/failure';
import { finishCreate } from './create/finish';
import { prepareCreate } from './create/preflight';

import type { CommandRequest } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { WorkstationRecord } from '#domain/workstation';

/**
 * creates one private workstation, configure it, verify readiness, then expose its agent
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param request parsed create options and explicit plugin selections
 * @param interaction optional inline review and progress boundary
 * @returns the ready workstation or a recoverable preflight/setup outcome
 */
export async function createWorkstation(
  dependencies: ApplicationDependencies,
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CommandResult> {
  const preparation = await traceStage({
    stage: 'create.preflight',
    action: async () => prepareCreate(dependencies, request, interaction),
    context: { succeeded: (result) => result.kind === 'ready' },
  });
  if (preparation.kind === 'result') {
    return preparation.result;
  }
  const context = preparation.context;
  interaction?.progress({
    stage: 'create',
    message: `Creating private workstation ${context.name}`,
  });
  let workstation: WorkstationRecord;
  try {
    workstation = await traceStage({
      stage: 'create.provider',
      action: async () =>
        context.provider.create(
          context.name,
          context.input.profile,
          agentPort(dependencies.registry, context.input.profile.agent),
        ),
    });
  } catch (error) {
    return creationOutcome(error, context.preflight);
  }
  try {
    return await traceStage({
      stage: 'create.finish',
      action: async () =>
        finishCreate(dependencies, { workstation, context, interaction }),
      context: { succeeded: (result) => result.ok },
    });
  } catch (error) {
    return markCreateIncomplete(dependencies, { workstation, context, error });
  }
}
