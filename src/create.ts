import { createManagedSprite } from '#integrations/sprites';

import { traceStage } from '#operation';

import { creationOutcome, markCreateIncomplete } from './create/failure.js';
import { finishCreate } from './create/finish.js';
import { prepareCreate } from './create/preflight.js';

import type { Sprite } from '@fly/sprites';

import type { CommandResult } from '#command';
import type { CommandRequest, Interaction } from '#command/contracts';

/**
 * creates one private Sprite, configure it, verify readiness, then expose T3
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
    message: `Creating private Sprite ${context.name}`,
  });
  let sprite: Sprite;
  try {
    sprite = await traceStage('create.provider', async () =>
      createManagedSprite(context.client, context.name),
    );
  } catch (error) {
    return creationOutcome(error, context.preflight);
  }
  try {
    return await traceStage(
      'create.finish',
      async () => finishCreate(sprite, context, interaction),
      { succeeded: (result) => result.ok },
    );
  } catch (error) {
    return markCreateIncomplete(sprite, context, error);
  }
}
