import type {
  Interaction,
  InteractionPrompt,
} from '#application/ports/interaction';

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
