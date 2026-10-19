import { publishStatus } from '#kernel/operation';

import type { Interaction } from '#application/ports/interaction';
import type { PlanProgress } from '#application/ports/plan';

/**
 * reports a plan event as progress to the interaction, or, without one, as a
 * status line, so a non-interactive run streams each step too
 * @param event the plan event
 * @param interaction the prompts and progress display, when interactive
 */
export function reportProgress(
  event: PlanProgress,
  interaction?: Interaction,
): void {
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
