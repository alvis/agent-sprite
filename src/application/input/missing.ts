import { networkDriver } from '#application/catalog/networks';
import { prerequisiteDetails, missingInput } from '#domain/prerequisites';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type {
  InputPrerequisite,
  PrerequisiteProblem,
} from '#domain/prerequisites';

import type { RequiredInput, ResolvedInputs } from './types';

/** the GitHub token guest setup authenticates with, as a declared input */
const GITHUB_TOKEN_INPUT: InputPrerequisite = {
  environment: 'GH_TOKEN',
  prompt: 'GitHub token',
  flag: '--github-token-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT',
};

/** the Git author identity commits are made with, as a declared input */
const GIT_IDENTITY_INPUT: InputPrerequisite = {
  environment: 'GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL',
  prompt: 'Git author identity',
  flag: '--git-name NAME and --git-email EMAIL',
};

/** what an absent Git identity needs, in the missingInput wording */
export const MISSING_GIT_IDENTITY = prerequisiteDetails([
  missingInput(
    GIT_IDENTITY_INPUT,
    'Or pass --no-git-identity to leave it unset.',
  ),
]);

/** what an absent GitHub token needs, in the missingInput wording */
export const MISSING_GITHUB_TOKEN = prerequisiteDetails([
  missingInput(
    GITHUB_TOKEN_INPUT,
    'Or pass --no-github to skip GitHub authentication.',
  ),
]);

/**
 * enumerates all provisioning values absent before remote account discovery,
 * each with every place it is read from
 * @param dependencies the registered drivers
 * @param input values resolved from explicit and local sources
 * @param required inputs needed by the selected workflow
 * @returns one actionable line per missing input
 */
export function missingProvisioningInputs(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  input: ResolvedInputs,
  required: readonly RequiredInput[],
): string[] {
  const network = networkDriver(
    dependencies.registry,
    input.profile.network,
  ).inputs;
  const networkChecks: Array<[RequiredInput, boolean, PrerequisiteProblem]> =
    network
      ? [
          [
            'networkEnrollment',
            Boolean(input.networkKey ?? input.enrollmentKey),
            missingInput(
              network.management,
              `Or set ${network.enrollment.environment} (${network.enrollment.flag}) to enrol with a single-use key.`,
            ),
          ],
          [
            'networkAccount',
            Boolean(input.networkAccount),
            missingInput(network.account),
          ],
          ['exitNode', Boolean(input.exitNode), missingInput(network.exitNode)],
        ]
      : [];
  const isProxyRequired =
    required.includes('proxyUrl') || required.includes('proxyApiKey');
  const gateway = isProxyRequired
    ? dependencies.registry.gateways.cliproxyapi.preflight({
        url: input.proxyUrl,
        apiKey: input.proxyApiKey,
      })
    : [];
  const absent = networkChecks
    .filter(([name, present]) => required.includes(name) && !present)
    .map(([, , problem]) => problem);

  return [
    ...(required.includes('name') && !input.name
      ? ['workstation name (--name)']
      : []),
    ...prerequisiteDetails([...absent, ...gateway]),
  ];
}
