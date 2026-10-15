import { agentPort } from '#core/services';
import { traceStage } from '#operation';

import { creationOutcome, markCreateIncomplete } from './create/failure.js';
import { finishCreate } from './create/finish.js';
import { prepareCreate } from './create/preflight.js';

import type { CommandResult } from '#command';
import type { CommandRequest, Interaction } from '#command/contracts';
import type { WorkstationRecord } from '#drivers/contracts';

/**
 * creates one private workstation, configure it, verify readiness, then expose its agent
 * @param request parsed create options and explicit plugin selections
 * @param interaction optional inline review and progress boundary
 * @returns the ready workstation or a recoverable preflight/setup outcome
 */
export async function createWorkstation(
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CommandResult> {
  const preparation = await traceStage(
    'create.preflight',
    async () => prepareCreate(request, interaction),
    { succeeded: (result) => result.kind === 'ready' },
  );
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
    workstation = await traceStage('create.provider', async () =>
      context.provider.create(
        context.name,
        context.input.profile,
        agentPort(context.input.profile.agent),
      ),
    );
  } catch (error) {
    return creationOutcome(error, context.preflight);
  }
  try {
    return await traceStage(
      'create.finish',
      async () => finishCreate(workstation, context, interaction),
      { succeeded: (result) => result.ok },
    );
  } catch (error) {
    return markCreateIncomplete(workstation, context, error);
  }
}
