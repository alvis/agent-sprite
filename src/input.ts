import { readLocalCredential } from '#integrations/credentials';

import { proxyUrlProblems } from '#integrations/native/proxy-url';

import { resolveBaseInputs } from './input/base.js';
import {
  discoverGithubToken,
  resolveGitIdentity,
  selectGithubToken,
} from './input/github.js';
import {
  integrationRequirements,
  resolveCreateIntegrations,
} from './input/integrations.js';
import { resolveInteractiveInputs } from './input/prompts.js';
import {
  readEnvironmentSources,
  readInputSources,
  resolveSecret,
} from './input/sources.js';

import type { CommandOptions, Interaction } from '#command/contracts';

import type { CredentialStoreLocation } from '#integrations/credentials';

import type { GuestIntegrations } from '#integrations/guest/types';

import type { GithubTokenCandidate } from './input/github.js';
import type { InputSources } from './input/sources.js';
import type { ResolvedInputs, RequiredInput } from './input/types.js';

export { retainManagementCredential } from './input/prompts.js';

export type {
  GitIdentity,
  ResolvedInputs,
  RequiredInput,
} from './input/types.js';

const BASE_CREATE_INPUTS: readonly RequiredInput[] = [
  'name',
  'spritesToken',
  'gitIdentity',
];

interface ResolveInputsOptions {
  credentialStore?: CredentialStoreLocation;
  discoverGithub?: boolean;
  integrations?: GuestIntegrations;
  required?: readonly RequiredInput[];
  sources?: InputSources;
}

/**
 * resolves explicit arguments, process environment, selected dotenv, profile, then prompts
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
    integrations: resolution.integrations,
    tailscaleEnrollment:
      required.includes('tailscaleEnrollment') ||
      resolution.integrations?.tailscale === true,
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
          ? ['Git author and committer name/email']
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
 * resolves optional-integration choices before any dependent create prompts
 * @param options parsed flags and explicit input sources
 * @param interaction optional inline choice prompts
 * @returns create inputs with requirements derived from the resolved choices
 */
export async function resolveCreateInputs(
  options: CommandOptions,
  interaction?: Interaction,
): Promise<ResolvedInputs> {
  const { sources, integrations, problems } = await resolveCreateIntegrations(
    options,
    interaction,
  );
  const required = integrationRequirements(integrations, BASE_CREATE_INPUTS);

  const input = await resolveInputs(options, interaction, {
    required,
    discoverGithub: true,
    integrations,
    sources,
  });

  return { ...input, missing: [...problems, ...input.missing] };
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

/**
 * enumerates all provisioning values absent before remote account discovery
 * @param input values resolved from explicit and local sources
 * @param required inputs needed by the selected workflow
 * @returns missing user-facing input names
 */
function missingProvisioningInputs(
  input: ResolvedInputs,
  required: readonly RequiredInput[],
): string[] {
  const checks: Array<[RequiredInput, boolean, string]> = [
    ['name', Boolean(input.name), 'workstation name (--name)'],
    ['spritesToken', Boolean(input.spritesToken), 'SPRITES_TOKEN'],
    [
      'tailscaleEnrollment',
      Boolean(input.tailscaleApiKey ?? input.tailscaleAuthKey),
      'TAILSCALE_API_KEY or TAILSCALE_AUTH_KEY',
    ],
    ['tailnet', Boolean(input.tailnet), 'TAILSCALE_TAILNET'],
    ['exitNode', Boolean(input.exitNode), 'TAILSCALE_EXIT_NODE'],
    ['proxyUrl', Boolean(input.proxyUrl), 'CLIPROXYAPI_BASE_URL'],
    ['proxyApiKey', Boolean(input.proxyApiKey), 'CLIPROXYAPI_API_KEY'],
  ];

  return checks
    .filter(([name, present]) => required.includes(name) && !present)
    .map(([, , description]) => description);
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
        ? ['Git author and committer name/email']
        : []),
      ...(required.includes('githubToken') &&
      options.github !== false &&
      !input.githubToken
        ? ['GitHub token']
        : []),
    ],
  };
}

/**
 * resolves only the local provider credential for read-only commands
 * @param options parsed selected provider token source
 * @param credentialStore optional explicitly selected real credential store
 * @returns the local provider token, if available
 */
export async function resolveSpritesToken(
  options: CommandOptions,
  credentialStore?: CredentialStoreLocation,
): Promise<string | undefined> {
  if (options.spritesTokenSource) {
    return resolveSecret(options.spritesTokenSource, undefined);
  }
  const sources = await readEnvironmentSources(options);
  const direct = [
    sources.processEnv.SPRITES_TOKEN,
    sources.fileEnv.SPRITES_TOKEN,
  ].find((value) => Boolean(value));
  const token = await resolveSecret(
    undefined,
    direct ??
      (options.localCredentials === false
        ? undefined
        : await readLocalCredential('sprites', credentialStore)),
  );

  return token;
}
