import { networkDriver } from '#core/networks';
import { prerequisiteDetails } from '#core/preflight';
import { validateProfile } from '#core/profile';
import { proxyUrlProblems } from '#drivers/shared/cliproxyapi/endpoints';
import { preflightCliproxyapi } from '#drivers/shared/cliproxyapi/preflight';
import { missingInput } from '#drivers/shared/prerequisites';
import { CommandFault } from '#errors';

import { resolveBaseInputs } from './input/base';
import { resolveGitIdentity, selectGithubToken } from './input/github';
import { discoverGithubToken } from './input/github-discovery';
import { resolveInteractiveInputs } from './input/prompts';
import {
  resolveCreateSelection,
  selectionRequirements,
} from './input/selection';
import { suppliedSelectionViolations } from './input/selection-supplied';
import { readInputSources } from './input/sources';

import type { CommandOptions, Interaction } from '#command/contracts';

import type { WorkstationProfile } from '#core/profile';
import type {
  InputPrerequisite,
  PrerequisiteProblem,
} from '#drivers/providers/prerequisites';
import type { CredentialStoreLocation } from '#integrations/credentials';

import type { GithubTokenCandidate } from './input/github';
import type { SelectionResolution } from './input/selection';
import type { Resolved } from './input/selection-sources';
import type { SuppliedSelection } from './input/selection-supplied';
import type { InputSources } from './input/sources';
import type { ResolvedInputs, RequiredInput } from './input/types';

const BASE_CREATE_INPUTS: readonly RequiredInput[] = [
  'name',
  'providerToken',
  'gitIdentity',
];

interface ResolveInputsOptions {
  credentialStore?: CredentialStoreLocation;
  discoverGithub?: boolean;
  profile?: WorkstationProfile;
  required?: readonly RequiredInput[];
  sources?: InputSources;
}

/**
 * resolves explicit arguments, selected dotenv, process environment, profile, then prompts
 * @param options parsed flags and explicit secret sources
 * @param interaction optional inline prompts
 * @param requirementSelection inputs or extended resolution settings
 * @returns values and an aggregate of inputs still missing
 */
export async function resolveInputs(
  options: CommandOptions,
  interaction?: Interaction,
  requirementSelection:
    readonly RequiredInput[] | ResolveInputsOptions = BASE_CREATE_INPUTS,
): Promise<ResolvedInputs> {
  const resolution = isResolveInputsOptions(requirementSelection)
    ? requirementSelection
    : { required: requirementSelection };
  const required = resolution.required ?? BASE_CREATE_INPUTS;
  const sources = resolution.sources ?? (await readInputSources(options));
  const { input, githubCandidate } = await resolveBaseInputs(options, sources, {
    profile: resolution.profile,
    networkEnrollment: required.includes('networkEnrollment'),
    credentialStore: resolution.credentialStore,
  });
  await resolveInteractiveInputs(input, {
    options,
    interaction,
    required,
    credentialStore: resolution.credentialStore,
  });
  const missingBeforeRemote = [
    ...missingProvisioningInputs(input, required),
    ...(required.includes('proxyUrl') ? proxyUrlProblems(input.proxyUrl) : []),
  ];
  if (options.nonInteractive && missingBeforeRemote.length > 0) {
    const localIdentity =
      required.includes('gitIdentity') && options.gitIdentity !== false
        ? await resolveGitIdentity({ options, sources })
        : undefined;

    return {
      ...input,
      gitIdentity: localIdentity,
      missing: [
        ...missingBeforeRemote,
        ...(!localIdentity &&
        !githubCandidate &&
        required.includes('gitIdentity') &&
        options.gitIdentity !== false
          ? MISSING_GIT_IDENTITY
          : []),
      ],
    };
  }

  return completeAccountInputs({
    options,
    interaction,
    required,
    sources,
    input,
    githubCandidate,
    missingBeforeRemote,
    discoverGithub: resolution.discoverGithub,
  });
}

/**
 * resolves the driver selection in dependency order, validates it before any
 * provider call, then resolves the inputs the selection needs
 * @param options parsed flags and explicit input sources
 * @param interaction optional inline choice prompts
 * @returns create inputs with requirements derived from the resolved selection
 * @throws {CommandFault} when the selection violates the catalog or a driver capability
 */
export async function resolveCreateInputs(
  options: CommandOptions,
  interaction?: Interaction,
): Promise<ResolvedInputs> {
  const sources = await readInputSources(options);
  const resolution = await resolveCreateSelection({
    options,
    sources,
    interaction,
  });
  const profile = requireValidProfile(resolution, options);
  const required = selectionRequirements(profile, BASE_CREATE_INPUTS);

  return resolveInputs(options, interaction, {
    required,
    discoverGithub: true,
    profile,
    sources,
  });
}

/**
 * validates a resolved selection against the catalog and driver capabilities
 * @param resolution selection resolved from every source, with its unreadable values
 * @param options parsed flags, for the pairing request
 * @returns the profile, once every catalog and capability rule holds
 * @throws {CommandFault} listing every violation at once
 */
export function requireValidProfile(
  resolution: SelectionResolution,
  options: CommandOptions,
): WorkstationProfile {
  const { candidate, problems, isIdleTimeoutRequested } = resolution;
  const validation = validateProfile(candidate, {
    isPairingRequested: options.withPairCode === true,
    isIdleTimeoutRequested,
  });
  if (!validation.isValid || problems.length > 0) {
    throw selectionFault([
      ...problems,
      ...(validation.isValid
        ? []
        : validation.violations.map(({ message }) => message)),
    ]);
  }

  return validation.profile;
}

/**
 * validates, before any provider or guest call, what a setup run's flags and
 * environment supply on their own
 * @param supplied values the run supplies, with its unreadable values
 * @param options parsed flags, for the pairing request
 * @throws {CommandFault} listing every violation at once
 */
export function requireValidSuppliedSelection(
  supplied: Resolved<SuppliedSelection>,
  options: CommandOptions,
): void {
  const details = [
    ...supplied.problems,
    ...suppliedSelectionViolations(supplied.value, {
      isPairingRequested: options.withPairCode === true,
    }).map(({ message }) => message),
  ];
  if (details.length > 0) {
    throw selectionFault(details);
  }
}

/**
 * reports every selection problem in one error
 * @param details one line per problem
 * @returns the INPUT fault
 */
function selectionFault(details: readonly string[]): CommandFault {
  return new CommandFault({
    code: 'INPUT',
    message: 'The workstation selection is invalid',
    details: [...details],
  });
}

/**
 * narrows extended input resolution settings from a plain requirement list
 * @param value requirement list or extended resolution settings
 * @returns whether the value contains extended settings
 */
function isResolveInputsOptions(
  value: readonly RequiredInput[] | ResolveInputsOptions,
): value is ResolveInputsOptions {
  return !Array.isArray(value);
}

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
const MISSING_GIT_IDENTITY = prerequisiteDetails([
  missingInput(
    GIT_IDENTITY_INPUT,
    'Or pass --no-git-identity to leave it unset.',
  ),
]);

/** what an absent GitHub token needs, in the missingInput wording */
const MISSING_GITHUB_TOKEN = prerequisiteDetails([
  missingInput(
    GITHUB_TOKEN_INPUT,
    'Or pass --no-github to skip GitHub authentication.',
  ),
]);

/**
 * enumerates all provisioning values absent before remote account discovery,
 * each with every place it is read from
 * @param input values resolved from explicit and local sources
 * @param required inputs needed by the selected workflow
 * @returns one actionable line per missing input
 */
function missingProvisioningInputs(
  input: ResolvedInputs,
  required: readonly RequiredInput[],
): string[] {
  const network = networkDriver(input.profile.network).inputs;
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
    ? preflightCliproxyapi({ url: input.proxyUrl, apiKey: input.proxyApiKey })
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

interface AccountResolutionContext {
  options: CommandOptions;
  interaction?: Interaction;
  required: readonly RequiredInput[];
  sources: InputSources;
  input: ResolvedInputs;
  githubCandidate?: string;
  missingBeforeRemote: string[];
  discoverGithub?: boolean;
}

/**
 * resolves optional GitHub and Git identity after mandatory inputs are known
 * @param context initial inputs and selected workflow requirements
 * @returns completed account values and remaining missing inputs
 */
async function completeAccountInputs(
  context: AccountResolutionContext,
): Promise<ResolvedInputs> {
  const {
    options,
    interaction,
    required,
    sources,
    input,
    githubCandidate,
    missingBeforeRemote,
    discoverGithub,
  } = context;
  const selectGithub =
    options.github !== false &&
    (discoverGithub === true || required.includes('githubToken'));
  const discovered =
    selectGithub && !githubCandidate
      ? await discoverGithubToken(options)
      : undefined;
  const candidate: GithubTokenCandidate | undefined = githubCandidate
    ? { token: githubCandidate, provenance: 'provided' }
    : discovered
      ? { token: discovered, provenance: 'gh-discovery' }
      : undefined;
  const selectedGithub = selectGithub
    ? await selectGithubToken(candidate, options, interaction)
    : undefined;
  input.githubToken = selectedGithub?.token;
  input.gitIdentity = required.includes('gitIdentity')
    ? await resolveGitIdentity({
        options,
        sources,
        verifiedAccount: selectedGithub?.account,
        interaction,
      })
    : undefined;

  return {
    ...input,
    missing: [
      ...missingBeforeRemote,
      ...(required.includes('gitIdentity') &&
      options.gitIdentity !== false &&
      (!interaction || options.nonInteractive) &&
      !input.gitIdentity
        ? MISSING_GIT_IDENTITY
        : []),
      ...(required.includes('githubToken') &&
      options.github !== false &&
      !input.githubToken
        ? MISSING_GITHUB_TOKEN
        : []),
    ],
  };
}
