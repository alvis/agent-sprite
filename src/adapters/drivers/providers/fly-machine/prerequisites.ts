import { checkDeclaredPrerequisites } from '#domain/prerequisites';

import { decodeToken, FLYCTL } from './flyctl';
import { tokenScopeProblem } from './token-scope';

import type {
  PrerequisiteProblem,
  ProviderPrerequisites,
  ProviderPreflightParams,
} from '#domain/prerequisites';

const TOKEN_SCOPE =
  'a Fly organization token able to create apps, machines and volumes';
const OBTAIN_TOKEN =
  'Create one with `fly tokens create org -o <organization>`; deploy, SSH and personal login tokens are refused.';

/** flyctl opens guest sessions and attenuates tokens; the organization token manages machines */
export const FLY_MACHINE_PREREQUISITES: ProviderPrerequisites = {
  tools: [
    {
      command: FLYCTL,
      // the oldest release whose `ssh console --machine -C`, `tokens debug`
      // and `tokens attenuate` behaviour the driver was verified against
      minimumVersion: '0.4.108',
      fix: 'Install or upgrade flyctl: https://fly.io/docs/flyctl/install/',
    },
  ],
  credential: {
    label: 'Fly organization token',
    environment: 'FLY_API_TOKEN',
    store: 'fly-machine',
    scope: TOKEN_SCOPE,
    obtain: OBTAIN_TOKEN,
    // a Sprites API token is refused before flyctl decodes anything
    refused: [
      {
        pattern: /^[\w-]+\/\d+\/[\da-f]+\/[\da-f]+$/u,
        holds: 'a Sprites API token',
      },
    ],
  },
  documentation: [
    'https://fly.io/docs/machines/api/',
    'https://fly.io/docs/security/tokens/',
    'https://fly.io/docs/flyctl/install/',
  ],
};

/**
 * checks flyctl, then the token: present, of a known shape, and decoded
 * offline by flyctl as an unexpired organization token with create and
 * delete access; no Fly API call is made
 * @param params resolved credential, its source and host tool probes
 * @param now current time, to refuse an expired token
 * @returns every missing or misconfigured prerequisite with its fix
 */
export async function preflightFlyMachine(
  params: ProviderPreflightParams,
  now = new Date(),
): Promise<PrerequisiteProblem[]> {
  const problems = await checkDeclaredPrerequisites(
    FLY_MACHINE_PREREQUISITES,
    params,
  );
  const { credential } = FLY_MACHINE_PREREQUISITES;
  const token = params.credential?.trim();
  const flyctl = await params.findTool(FLYCTL);
  const decodable =
    token &&
    flyctl &&
    !problems.some(({ subject }) =>
      [FLYCTL, credential.environment].includes(subject),
    );
  if (!decodable) {
    return problems;
  }
  const printed = await decodeToken(flyctl, token);
  const scope = tokenScopeProblem(printed ?? '', now);

  return scope
    ? [
        ...problems,
        {
          subject: credential.environment,
          problem: `${params.credentialSource ?? 'The entered value'} ${scope}; the provider needs ${TOKEN_SCOPE}`,
          fix: `Replace it with ${TOKEN_SCOPE}. ${OBTAIN_TOKEN}`,
        },
      ]
    : problems;
}
