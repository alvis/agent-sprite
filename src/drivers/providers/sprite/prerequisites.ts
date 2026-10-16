import { checkDeclaredPrerequisites } from '#drivers/shared/prerequisites';

import type {
  PrerequisiteProblem,
  ProviderPrerequisites,
  ProviderPreflightParams,
} from '#drivers/providers/prerequisites';

/** the Sprites SDK needs no host tool; only the organization token */
export const SPRITE_PREREQUISITES: ProviderPrerequisites = {
  tools: [],
  credential: {
    label: 'Sprites API token',
    environment: 'SPRITES_TOKEN',
    store: 'sprites',
    scope:
      'a Sprites organization token for the organization that owns the workstations',
    obtain:
      'Get one at https://sprites.dev/account; sign in with Fly and select the intended organization.',
    // Fly API, deploy and organization macaroons, which the Sprites API refuses;
    // any other shape is left for the Sprites API to accept or reject as AUTH
    refused: [
      { pattern: /^(?:FlyV1\s|fm\d_|fo\d_)/u, holds: 'a Fly API token' },
    ],
  },
  documentation: [
    'https://docs.fly.io/sprites/cli/authentication',
    'https://docs.fly.io/sprites/quickstart',
  ],
};

/**
 * checks the declared credential and refuses, offline, a Fly API token
 * @param params resolved credential, its source and host tool probes
 * @returns every missing or misconfigured prerequisite with its fix
 */
export async function preflightSprite(
  params: ProviderPreflightParams,
): Promise<PrerequisiteProblem[]> {
  return checkDeclaredPrerequisites(SPRITE_PREREQUISITES, params);
}
