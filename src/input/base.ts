import { readLocalCredential } from '#integrations/credentials';
import { runOperation } from '#operation';

import { resolveSecret, runtimeEnvironment } from './sources.js';

import type { CommandOptions } from '#command/contracts';

import type {
  CredentialStoreLocation,
  ManagementCredentialName,
} from '#integrations/credentials';
import type { GuestIntegrations } from '#integrations/guest/types';

import type { InputSources } from './sources.js';
import type { ResolvedInputs } from './types.js';

type SourceReader = (name: string, explicit?: string) => string | undefined;

interface SecretValues {
  spritesToken?: string;
  tailscaleApiKey?: string;
  tailscaleAuthKey?: string;
  proxyApiKey?: string;
  githubCandidate?: string;
}

/** selected local fallback requirements for this real input resolution */
export interface BaseInputSelection {
  integrations?: GuestIntegrations;
  tailscaleEnrollment?: boolean;
  credentialStore?: CredentialStoreLocation;
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
 * @param settings integration choices and selected local fallback
 * @returns initial inputs and candidate GitHub credential
 */
export async function resolveBaseInputs(
  options: CommandOptions,
  sources: InputSources,
  settings: GuestIntegrations | BaseInputSelection = {},
): Promise<{ input: ResolvedInputs; githubCandidate?: string }> {
  const selection =
    'tailscale' in settings ? { integrations: settings } : settings;
  const integrations = selection.integrations ?? {
    tailscale: false,
    exitNode: false,
    cliproxyapi: false,
  };
  const sourceNames: Record<string, string> = {};
  const value = sourceReader(options, sources, sourceNames);
  const runtimeEnv = runtimeEnvironment(sources.fileEnv);
  const secrets = await resolveSelectedSecrets(options, value, {
    ...selection,
    tailscaleEnrollment:
      selection.tailscaleEnrollment ?? integrations.tailscale,
  });
  annotateSecretSources(options, secrets, sourceNames);
  const input: ResolvedInputs = {
    name: options.name,
    spritesToken: secrets.spritesToken,
    tailscaleApiKey: secrets.tailscaleApiKey,
    tailscaleAuthKey: secrets.tailscaleAuthKey,
    tailnet: value('TAILSCALE_TAILNET', options.tailnet),
    exitNode: value('TAILSCALE_EXIT_NODE', options.exitNode),
    proxyUrl: value('CLIPROXYAPI_BASE_URL', options.proxyUrl),
    proxyApiKey: secrets.proxyApiKey,
    integrations,
    runtimeEnv,
    sources: sourceNames,
    missing: [],
  };

  return { input, githubCandidate: secrets.githubCandidate };
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
      { value: sources.fileEnv[name], description: options.env ?? 'env file' },
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
 * @param selection required local fallback and optional real store location
 * @returns selected secrets before optional GitHub confirmation
 */
async function resolveSelectedSecrets(
  options: CommandOptions,
  value: SourceReader,
  selection: BaseInputSelection,
): Promise<SecretValues> {
  const [
    spritesToken,
    tailscaleApiKey,
    tailscaleAuthKey,
    proxyApiKey,
    githubCandidate,
  ] = await runOperation(async () =>
    Promise.all([
      resolveManagementSecret(
        {
          reference: options.spritesTokenSource,
          environment: 'SPRITES_TOKEN',
          store: 'sprites',
          useStore: options.localCredentials !== false,
          location: selection.credentialStore,
        },
        value,
      ),
      resolveManagementSecret(
        {
          reference: options.tailscaleApiKeySource,
          environment: 'TAILSCALE_API_KEY',
          store: 'tailscale',
          useStore:
            options.localCredentials !== false &&
            selection.tailscaleEnrollment === true,
          location: selection.credentialStore,
        },
        value,
      ),
      resolveSecret(
        options.tailscaleAuthKeySource,
        value('TAILSCALE_AUTH_KEY'),
      ),
      resolveSecret(options.proxyApiKeySource, value('CLIPROXYAPI_API_KEY')),
      options.github === false
        ? Promise.resolve(undefined)
        : resolveSecret(
            options.githubTokenSource,
            value('GH_TOKEN') ?? value('GITHUB_TOKEN'),
          ),
    ]),
  );

  return {
    spritesToken,
    tailscaleApiKey,
    tailscaleAuthKey,
    proxyApiKey,
    githubCandidate,
  };
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
 * @param names source descriptions updated in place
 */
function annotateSecretSources(
  options: CommandOptions,
  secrets: SecretValues,
  names: Record<string, string>,
): void {
  if (options.spritesTokenSource) {
    names.SPRITES_TOKEN = 'explicit secret reference';
  } else if (secrets.spritesToken && !names.SPRITES_TOKEN) {
    names.SPRITES_TOKEN = 'local credential store';
  }
  if (options.tailscaleApiKeySource) {
    names.TAILSCALE_API_KEY = 'explicit secret reference';
  } else if (secrets.tailscaleApiKey && !names.TAILSCALE_API_KEY) {
    names.TAILSCALE_API_KEY = 'local credential store';
  }
  if (options.proxyApiKeySource) {
    names.CLIPROXYAPI_API_KEY = 'explicit secret reference';
  }
  if (options.githubTokenSource) {
    names.GH_TOKEN = 'explicit secret reference';
  }
}
