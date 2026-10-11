/** actionable, bounded guidance shared by create and authenticated commands */
export const spritesTokenGuidance = [
  'Set SPRITES_TOKEN or pass --env FILE containing SPRITES_TOKEN.',
  'Use --sprites-token-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT.',
  'Run in a TTY to enter a token when prompted.',
  'Get a token at https://sprites.dev/account; sign in with Fly and select the intended organization.',
] as const;

/** context shown while entering a Sprites credential */
export const spritesTokenPromptDescription =
  'Get a token at https://sprites.dev/account; sign in with Fly and select the intended organization.';
