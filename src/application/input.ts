import { validateProfile } from '#domain/profile';
import { CommandFault } from '#kernel/faults';

import { resolveBaseInputs } from './input/base';
import { resolveGitIdentity } from './input/git-identity';
import { selectGithubToken } from './input/github';
import { discoverGithubToken } from './input/github-discovery';
import {
  MISSING_GIT_IDENTITY,
  MISSING_GITHUB_TOKEN,
  missingProvisioningInputs,
} from './input/missing';
import { resolveInteractiveInputs } from './input/prompts';
import {
  resolveCreateSelection,
  selectionRequirements,
} from './input/selection';
import { suppliedSelectionViolations } from './input/selection-supplied';
import { readInputSources } from './input/sources';

import type { CommandOptions } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';

import type { CredentialStoreLocation } from '#domain/credentials';
import type { WorkstationProfile } from '#domain/profile';

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

/** the named inputs of resolve inputs */
export interface ResolveInputsParams {
  /** parsed flags and explicit secret sources */
  options: CommandOptions;
  /** optional inline prompts */
  interaction?: Interaction;
  /** inputs or extended resolution settings */
  requirementSelection?: readonly RequiredInput[] | ResolveInputsOptions;
}

/**
 * resolves explicit arguments, selected dotenv, process environment, profile, then prompts
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param params the call's inputs: options, interaction, requirementSelection
 * @returns values and an aggregate of inputs still missing
 */
export async function resolveInputs(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults' | 'host'>,
  params: ResolveInputsParams,
): Promise<ResolvedInputs> {
  const {
    options,
    interaction,
    requirementSelection = BASE_CREATE_INPUTS,
  } = params;
  const resolution = isResolveInputsOptions(requirementSelection)
    ? requirementSelection
    : { required: requirementSelection };
  const required = resolution.required ?? BASE_CREATE_INPUTS;
  const sources =
    resolution.sources ?? (await readInputSources(dependencies, options));
  const { input, githubCandidate } = await resolveBaseInputs(dependencies, {
    options,
    sources,
    selection: {
      profile: resolution.profile,
      networkEnrollment: required.includes('networkEnrollment'),
      credentialStore: resolution.credentialStore,
    },
  });
  await resolveInteractiveInputs(dependencies, input, {
    options,
    interaction,
    required,
    credentialStore: resolution.credentialStore,
  });
  const missingBeforeRemote = [
    ...missingProvisioningInputs(dependencies, input, required),
    ...(required.includes('proxyUrl')
      ? dependencies.registry.gateways.cliproxyapi.urlProblems(input.proxyUrl)
      : []),
  ];
  if (options.nonInteractive && missingBeforeRemote.length > 0) {
    return withLocalIdentity(dependencies, {
      options,
      required,
      sources,
      input,
      githubCandidate,
      missingBeforeRemote,
    });
  }

  return completeAccountInputs(dependencies, {
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
 * reports what is missing without any remote account call
 * @param dependencies what this computer provides
 * @param context inputs resolved so far and the problems already found
 * @returns the inputs with only the local Git identity resolved
 */
async function withLocalIdentity(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  context: Omit<AccountResolutionContext, 'interaction' | 'discoverGithub'>,
): Promise<ResolvedInputs> {
  const { options, required, sources, input, githubCandidate } = context;
  const localIdentity =
    required.includes('gitIdentity') && options.gitIdentity !== false
      ? await resolveGitIdentity(dependencies, { options, sources })
      : undefined;

  return {
    ...input,
    gitIdentity: localIdentity,
    missing: [
      ...context.missingBeforeRemote,
      ...(!localIdentity &&
      !githubCandidate &&
      required.includes('gitIdentity') &&
      options.gitIdentity !== false
        ? MISSING_GIT_IDENTITY
        : []),
    ],
  };
}

/**
 * resolves the driver selection in dependency order, validates it before any
 * provider call, then resolves the inputs the selection needs
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param options parsed flags and explicit input sources
 * @param interaction optional inline choice prompts
 * @returns create inputs with requirements derived from the resolved selection
 * @throws {CommandFault} when the selection violates the catalog or a driver capability
 */
export async function resolveCreateInputs(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults' | 'host'>,
  options: CommandOptions,
  interaction?: Interaction,
): Promise<ResolvedInputs> {
  const sources = await readInputSources(dependencies, options);
  const resolution = await resolveCreateSelection(dependencies, {
    options,
    sources,
    interaction,
  });
  const profile = requireValidProfile(dependencies, resolution, options);
  const required = selectionRequirements(dependencies, {
    profile,
    base: BASE_CREATE_INPUTS,
  });

  return resolveInputs(dependencies, {
    options,
    interaction,
    requirementSelection: {
      required,
      discoverGithub: true,
      profile,
      sources,
    },
  });
}

/**
 * validates a resolved selection against the catalog and driver capabilities
 * @param dependencies the registered drivers
 * @param resolution selection resolved from every source, with its unreadable values
 * @param options parsed flags, for the pairing request
 * @returns the profile, once every catalog and capability rule holds
 * @throws {CommandFault} listing every violation at once
 */
export function requireValidProfile(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  resolution: SelectionResolution,
  options: CommandOptions,
): WorkstationProfile {
  const { candidate, problems, isIdleTimeoutRequested } = resolution;
  const validation = validateProfile(dependencies.registry, candidate, {
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
 * @param dependencies the registered drivers, the profile defaults
 * @param supplied values the run supplies, with its unreadable values
 * @param options parsed flags, for the pairing request
 * @throws {CommandFault} listing every violation at once
 */
export function requireValidSuppliedSelection(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  supplied: Resolved<SuppliedSelection>,
  options: CommandOptions,
): void {
  const details = [
    ...supplied.problems,
    ...suppliedSelectionViolations(dependencies, supplied.value, {
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
 * @param dependencies what this computer provides
 * @param context initial inputs and selected workflow requirements
 * @returns completed account values and remaining missing inputs
 */
async function completeAccountInputs(
  dependencies: Pick<ApplicationDependencies, 'host'>,
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
      ? await discoverGithubToken(dependencies, options)
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
    ? await resolveGitIdentity(dependencies, {
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
