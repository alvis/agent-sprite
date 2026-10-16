import type { Interaction, InteractionPrompt } from '#command/contracts';

/** user-requested navigation, distinct from an operation failure */
export class InteractionExit extends Error {
  public readonly action: 'back' | 'cancel';

  /**
   * identifies a navigation request without an operational error message
   * @param action requested navigation direction
   */
  constructor(action: 'back' | 'cancel') {
    super(action === 'back' ? 'Back requested.' : 'Cancelled by user.');
    this.action = action;
  }
}

/**
 * returns to a parent menu on back while preserving aborts and actual failures
 * @param operation one safe pre-mutation prompt or guarded workflow
 * @returns accepted value, or undefined for back navigation
 */
export async function returnOnBack<T>(
  operation: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof InteractionExit) || error.action !== 'back') {
      throw error;
    }

    return undefined;
  }
}

/**
 * labels nested prompts with their safe return destination
 * @param interaction current UI boundary
 * @param backLabel destination shown for Escape
 * @returns prompts retaining explicit inner navigation labels
 */
export function withBackNavigation(
  interaction: Interaction,
  backLabel: string,
): Interaction {
  const promptWithBack = <Prompt extends Pick<InteractionPrompt, 'backLabel'>>(
    prompt: Prompt,
  ): Prompt => ({
    ...prompt,
    backLabel: prompt.backLabel ?? backLabel,
  });

  return {
    ...interaction,
    input: async (prompt) => interaction.input(promptWithBack(prompt)),
    secret: async (prompt) => interaction.secret(promptWithBack(prompt)),
    select: async (prompt, choices) =>
      interaction.select(promptWithBack(prompt), choices),
    multiselect: async (prompt, choices) =>
      interaction.multiselect(promptWithBack(prompt), choices),
    confirm: async (prompt) => interaction.confirm(promptWithBack(prompt)),
  };
}
