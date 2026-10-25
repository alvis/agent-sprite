import { networkDriver } from '#application/catalog/networks';
import { defaultProfile } from '#domain/profile';
import { runOperation } from '#kernel/operation';

import { resolveProviderCredential } from './provider-credential';

import { resolveSecret, runtimeEnvironment } from './sources';

import type { CommandOptions } from '#application/contracts';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type {
  CredentialStoreLocation,
  ManagementCredentialName,
} from '#domain/credentials';
import type { NetworkInputs } from '#domain/declarations';
import type { WorkstationProfile } from '#domain/profile';

import type { InputSources } from './sources';
import type { ResolvedInputs } from './types';

type SourceReader = (name: string, explicit?: string) => string | undefined;

interface SecretValues {
  providerToken?: string;
  providerTokenSource?: string;
  networkKey?: string;
  enrollmentKey?: string;
  proxyApiKey?: string;
  githubCandidate?: string;
}

/** selected local fallback requirements for this real input resolution */
interface BaseInputSelection {
  /** driver selection whose declared inputs are read */
  profile?: WorkstationProfile;
  /** the workflow may fall back to the saved network management credential */
  networkEnrollment?: boolean;
  credentialStore?: CredentialStoreLocation;
}

/** environment names of the provider and network credentials this run reads */
interface DeclaredNames {
  provider: { environment: string; store: ManagementCredentialName };
  network?: NetworkInputs;
}

interface ManagementSecretSelection {
  reference?: string;
  environment: string;
  store: ManagementCredentialName;
  useStore: boolean;
  location?: CredentialStoreLocation;
}

/** the named inputs of resolve base inputs */
export interface ResolveBaseInputsParams {
  /** parsed explicit values and secret references */
  options: CommandOptions;
  /** process, credential file, and profile values */
  sources: InputSources;
  /** resolved profile and selected local credential fallback */
  selection?: BaseInputSelection;
}

/**
 * resolves initial create/setup inputs before optional inline prompts
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param params the call's inputs: options, sources, selection
 * @returns initial inputs and candidate GitHub credential
 */
export async function resolveBaseInputs(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults' | 'host'>,
  params: ResolveBaseInputsParams,
): Promise<{ input: ResolvedInputs; githubCandidate?: string }> {
  const { options, sources, selection = {} } = params;
  const profile = selection.profile ?? defaultProfile(dependencies.defaults);
  const names = declaredNames(dependencies, profile);
  const sourceNames: Record<string, string> = {};
  const value = sourceReader(options, sources, sourceNames);
  const runtimeEnv = runtimeEnvironment(
    dependencies,
    sources.runtimeFileEnv ?? {},
  );
  const secrets = await resolveSelectedSecrets(dependencies, {
    options,
    value,
    profile,
    sources,
    names,
    useNetworkStore: selection.networkEnrollment ?? names.network !== undefined,
    credentialStore: selection.credentialStore,
  });
  annotateSecretSources(options, secrets, {
    names,
    proxyApiKey:
      dependencies.registry.gateways.cliproxyapi.inputs.apiKey.environment,
    sources: sourceNames,
  });
  const network = names.network;
  const input: ResolvedInputs = {
    name: options.name,
    providerToken: secrets.providerToken,
    networkKey: secrets.networkKey,
    enrollmentKey: secrets.enrollmentKey,
    networkAccount: network
      ? value(network.account.environment, options.networkAccount)
      : options.networkAccount,
    exitNode: network
      ? value(network.exitNode.environment, options.exitNode)
      : options.exitNode,
    proxyUrl: value(
      dependencies.registry.gateways.cliproxyapi.inputs.baseUrl.environment,
      options.proxyUrl,
    ),
    proxyApiKey: secrets.proxyApiKey,
    profile,
    runtimeEnv,
    sources: sourceNames,
    missing: [],
  };

  return { input, githubCandidate: secrets.githubCandidate };
}

/**
 * reads the credential and input names the selected drivers declare
 * @param dependencies the registered drivers
 * @param profile driver selection
 * @returns provider credential names and the network's inputs, when it has a driver
 */
function declaredNames(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  profile: WorkstationProfile,
): DeclaredNames {
  const { credential } =
    dependencies.registry.providers[profile.provider].prerequisites;

  return {
    provider: { environment: credential.environment, store: credential.store },
    network: networkDriver(dependencies.registry, profile.network).inputs,
  };
}

/**
 * selects non-secret values in explicit, credential file, process, profile order
 * @param options parsed selected credential file path
 * @param sources process, dotenv, and profile values
 * @param names output map of selected source descriptions
 * @returns a precedence-aware value reader
 */
function sourceReader(
  options: CommandOptions,
  sources: InputSources,
  names: Record<string, string>,
): SourceReader {
  return (name, explicit) => {
    const ordered = [
      { value: explicit, description: 'flag' },
      {
        value: sources.fileEnv[name],
        description: options.credentialFile ?? 'credential file',
      },
      { value: sources.processEnv[name], description: 'process environment' },
      { value: sources.profile[name], description: 'saved profile' },
    ];
    const selected = ordered.find((entry) => Boolean(entry.value));
    if (selected) {
      names[name] = selected.description;
    }

    return selected?.value;
  };
}

/** the named inputs of resolve selected secrets */
interface ResolveSelectedSecretsParams {
  /** parsed secret references and local credential policy */
  options: CommandOptions;
  /** non-secret precedence reader for environment values */
  value: SourceReader;
  /** driver selection whose provider credential is read */
  profile: WorkstationProfile;
  /** process and credential file values */
  sources: InputSources;
  /** credential names the selected drivers declare */
  names: DeclaredNames;
  /** the network management credential may come from the local store */
  useNetworkStore: boolean;
  /** optional explicitly selected real store */
  credentialStore?: CredentialStoreLocation;
}

/**
 * resolves secret references without transferring management credentials to the guest
 * @param dependencies the registered drivers, what this computer provides
 * @param params the call's inputs: options, value, profile, sources, names, useNetworkStore, credentialStore
 * @returns selected secrets before optional GitHub confirmation
 */
async function resolveSelectedSecrets(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  params: ResolveSelectedSecretsParams,
): Promise<SecretValues> {
  const { options, value, profile, sources, names } = params;
  const { useNetworkStore, credentialStore } = params;
  const useStore = options.localCredentials !== false;
  const [provider, networkKey, enrollmentKey, proxyApiKey, githubCandidate] =
    await runOperation(async () =>
      Promise.all([
        resolveProviderCredential(dependencies, {
          options,
          provider: profile.provider,
          selection: {
            reference: options.providerTokenSource,
            sources,
            credentialStore,
          },
        }),
        resolveNetworkSecret(dependencies, {
          ...params,
          useNetworkStore: useStore && useNetworkStore,
        }),
        resolveSecret(
          dependencies,
          options.networkAuthKeySource,
          names.network
            ? value(names.network.enrollment.environment)
            : undefined,
        ),
        resolveSecret(
          dependencies,
          options.proxyApiKeySource,
          value(
            dependencies.registry.gateways.cliproxyapi.inputs.apiKey
              .environment,
          ),
        ),
        options.github === false
          ? Promise.resolve(undefined)
          : resolveSecret(
              dependencies,
              options.githubTokenSource,
              value('GH_TOKEN') ?? value('GITHUB_TOKEN'),
            ),
      ]),
    );

  return {
    providerToken: provider.token,
    providerTokenSource: provider.source,
    networkKey,
    enrollmentKey,
    proxyApiKey,
    githubCandidate,
  };
}

/** the named inputs of resolve network secret */
interface ResolveNetworkSecretParams {
  /** parsed secret references and local credential policy */
  options: CommandOptions;
  /** non-secret precedence reader for environment values */
  value: SourceReader;
  /** credential names the selected drivers declare */
  names: DeclaredNames;
  /** the credential may come from the local store */
  useNetworkStore: boolean;
  /** optional explicitly selected real store */
  credentialStore?: CredentialStoreLocation;
}

/**
 * resolves the selected network's management credential, when a network is selected
 * @param dependencies what this computer provides
 * @param params the call's inputs: options, value, names, useNetworkStore, credentialStore
 * @returns the network management credential, if any
 */
async function resolveNetworkSecret(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  params: ResolveNetworkSecretParams,
): Promise<string | undefined> {
  const { options, value, names, useNetworkStore, credentialStore } = params;
  const { network } = names;

  return network
    ? resolveManagementSecret(
        dependencies,
        {
          reference: options.networkKeySource,
          environment: network.management.environment,
          store: network.management.store,
          useStore: useNetworkStore,
          location: credentialStore,
        },
        value,
      )
    : undefined;
}

/**
 * reads a local credential only when neither an explicit nor direct value won
 * @param dependencies what this computer provides
 * @param selection source and store fallback selected by the workflow
 * @param value direct source reader in precedence order
 * @returns selected secret with its value registered for redaction
 */
async function resolveManagementSecret(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  selection: ManagementSecretSelection,
  value: SourceReader,
): Promise<string | undefined> {
  if (selection.reference) {
    return resolveSecret(dependencies, selection.reference, undefined);
  }
  const direct = value(selection.environment);
  const fallback =
    direct ??
    (selection.useStore
      ? await dependencies.host.credentials.read(
          selection.store,
          selection.location,
        )
      : undefined);

  return resolveSecret(dependencies, undefined, fallback);
}

/**
 * labels selected local and explicit secret sources without recording values
 * @param options parsed explicit secret references
 * @param secrets resolved secret presence
 * @param context declared credential names and the source descriptions updated in place
 * @param context.names credential names the selected drivers declare
 * @param context.proxyApiKey environment variable the gateway reads its API key from
 * @param context.sources source descriptions keyed by environment name
 */
function annotateSecretSources(
  options: CommandOptions,
  secrets: SecretValues,
  context: {
    names: DeclaredNames;
    proxyApiKey: string;
    sources: Record<string, string>;
  },
): void {
  const { names, proxyApiKey, sources } = context;
  const label = (
    environment: string,
    reference: string | undefined,
    resolved: string | undefined,
  ): void => {
    if (reference) {
      sources[environment] = 'explicit secret reference';
    } else if (resolved && !sources[environment]) {
      sources[environment] = 'local credential store';
    }
  };
  if (secrets.providerTokenSource) {
    sources[names.provider.environment] = secrets.providerTokenSource;
  }
  if (names.network) {
    label(
      names.network.management.environment,
      options.networkKeySource,
      secrets.networkKey,
    );
  }
  if (options.proxyApiKeySource) {
    sources[proxyApiKey] = 'explicit secret reference';
  }
  if (options.githubTokenSource) {
    sources.GH_TOKEN = 'explicit secret reference';
  }
}
