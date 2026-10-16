import { catalog } from '#core/catalog';
import { networkDriver } from '#core/networks';
import { defaultProfile } from '#core/profile';
import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';
import { readLocalCredential } from '#integrations/credentials';
import { runOperation } from '#operation';

import { resolveProviderCredential } from './provider-credential.js';

import { resolveSecret, runtimeEnvironment } from './sources.js';

import type { CommandOptions } from '#command/contracts';

import type { WorkstationProfile } from '#core/profile';
import type { NetworkInputs } from '#drivers/networks/contracts';
import type {
  CredentialStoreLocation,
  ManagementCredentialName,
} from '#integrations/credentials';

import type { InputSources } from './sources.js';
import type { ResolvedInputs } from './types.js';

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

/**
 * resolves initial create/setup inputs before optional inline prompts
 * @param options parsed explicit values and secret references
 * @param sources process, dotenv, and profile values
 * @param selection resolved profile and selected local credential fallback
 * @returns initial inputs and candidate GitHub credential
 */
export async function resolveBaseInputs(
  options: CommandOptions,
  sources: InputSources,
  selection: BaseInputSelection = {},
): Promise<{ input: ResolvedInputs; githubCandidate?: string }> {
  const profile = selection.profile ?? defaultProfile();
  const names = declaredNames(profile);
  const sourceNames: Record<string, string> = {};
  const value = sourceReader(options, sources, sourceNames);
  const runtimeEnv = runtimeEnvironment(sources.fileEnv);
  const secrets = await resolveSelectedSecrets(options, value, {
    profile,
    sources,
    names,
    useNetworkStore: selection.networkEnrollment ?? names.network !== undefined,
    credentialStore: selection.credentialStore,
  });
  annotateSecretSources(options, secrets, { names, sources: sourceNames });
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
    proxyUrl: value(CLIPROXYAPI_INPUTS.baseUrl.environment, options.proxyUrl),
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
 * @param profile driver selection
 * @returns provider credential names and the network's inputs, when it has a driver
 */
function declaredNames(profile: WorkstationProfile): DeclaredNames {
  const { credential } = catalog.providers[profile.provider].prerequisites;

  return {
    provider: { environment: credential.environment, store: credential.store },
    network: networkDriver(profile.network).inputs,
  };
}

/**
 * selects non-secret values in explicit, process, dotenv, profile order
 * @param options parsed selected dotenv path
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
      { value: sources.processEnv[name], description: 'process environment' },
      {
        value: sources.fileEnv[name],
        description: options.envFile ?? 'env file',
      },
      { value: sources.profile[name], description: 'saved profile' },
    ];
    const selected = ordered.find((entry) => Boolean(entry.value));
    if (selected) {
      names[name] = selected.description;
    }

    return selected?.value;
  };
}

/**
 * resolves secret references without transferring management credentials to the guest
 * @param options parsed secret references and local credential policy
 * @param value non-secret precedence reader for environment values
 * @param selection driver selection, sources, declared names and store fallbacks
 * @param selection.profile driver selection whose provider credential is read
 * @param selection.sources process and env file values
 * @param selection.names credential names the selected drivers declare
 * @param selection.useNetworkStore the network management credential may come from the local store
 * @param selection.credentialStore optional explicitly selected real store
 * @returns selected secrets before optional GitHub confirmation
 */
async function resolveSelectedSecrets(
  options: CommandOptions,
  value: SourceReader,
  selection: {
    profile: WorkstationProfile;
    sources: InputSources;
    names: DeclaredNames;
    useNetworkStore: boolean;
    credentialStore?: CredentialStoreLocation;
  },
): Promise<SecretValues> {
  const { names, credentialStore } = selection;
  const useStore = options.localCredentials !== false;
  const [provider, networkKey, enrollmentKey, proxyApiKey, githubCandidate] =
    await runOperation(async () =>
      Promise.all([
        resolveProviderCredential(options, selection.profile.provider, {
          reference: options.providerTokenSource,
          sources: selection.sources,
          credentialStore,
        }),
        resolveNetworkSecret(options, value, {
          ...selection,
          useNetworkStore: useStore && selection.useNetworkStore,
        }),
        resolveSecret(
          options.networkAuthKeySource,
          names.network
            ? value(names.network.enrollment.environment)
            : undefined,
        ),
        resolveSecret(
          options.proxyApiKeySource,
          value(CLIPROXYAPI_INPUTS.apiKey.environment),
        ),
        options.github === false
          ? Promise.resolve(undefined)
          : resolveSecret(
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

/**
 * resolves the selected network's management credential, when a network is selected
 * @param options parsed secret references and local credential policy
 * @param value non-secret precedence reader for environment values
 * @param selection declared names, store permission and optional real store location
 * @param selection.names credential names the selected drivers declare
 * @param selection.useNetworkStore the credential may come from the local store
 * @param selection.credentialStore optional explicitly selected real store
 * @returns the network management credential, if any
 */
async function resolveNetworkSecret(
  options: CommandOptions,
  value: SourceReader,
  selection: {
    names: DeclaredNames;
    useNetworkStore: boolean;
    credentialStore?: CredentialStoreLocation;
  },
): Promise<string | undefined> {
  const { network } = selection.names;

  return network
    ? resolveManagementSecret(
        {
          reference: options.networkKeySource,
          environment: network.management.environment,
          store: network.management.store,
          useStore: selection.useNetworkStore,
          location: selection.credentialStore,
        },
        value,
      )
    : undefined;
}

/**
 * reads a local credential only when neither an explicit nor direct value won
 * @param selection source and store fallback selected by the workflow
 * @param value direct source reader in precedence order
 * @returns selected secret with its value registered for redaction
 */
async function resolveManagementSecret(
  selection: ManagementSecretSelection,
  value: SourceReader,
): Promise<string | undefined> {
  if (selection.reference) {
    return resolveSecret(selection.reference, undefined);
  }
  const direct = value(selection.environment);
  const fallback =
    direct ??
    (selection.useStore
      ? await readLocalCredential(selection.store, selection.location)
      : undefined);

  return resolveSecret(undefined, fallback);
}

/**
 * labels selected local and explicit secret sources without recording values
 * @param options parsed explicit secret references
 * @param secrets resolved secret presence
 * @param context declared credential names and the source descriptions updated in place
 * @param context.names credential names the selected drivers declare
 * @param context.sources source descriptions keyed by environment name
 */
function annotateSecretSources(
  options: CommandOptions,
  secrets: SecretValues,
  context: { names: DeclaredNames; sources: Record<string, string> },
): void {
  const { names, sources } = context;
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
    sources[CLIPROXYAPI_INPUTS.apiKey.environment] =
      'explicit secret reference';
  }
  if (options.githubTokenSource) {
    sources.GH_TOKEN = 'explicit secret reference';
  }
}
