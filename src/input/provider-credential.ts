import { catalog } from '#core/catalog';
import { readLocalCredential } from '#integrations/credentials';

import { readEnvironmentSources, resolveSecret } from './sources.js';

import type { CommandOptions } from '#command/contracts';
import type { ProviderId } from '#core/catalog';
import type { CredentialStoreLocation } from '#integrations/credentials';

import type { InputSources } from './sources.js';

/** a provider credential and the place it was read from */
export interface ProviderCredential {
  /** the credential, when any declared source holds one */
  token?: string;
  /** where the credential was read from, named for the caller */
  source?: string;
}

/** where a provider credential may be read from */
interface ProviderCredentialSources {
  /** the explicit secret reference that names this provider's credential */
  reference?: string;
  /** process and env file values, read from the options when omitted */
  sources?: Pick<InputSources, 'processEnv' | 'fileEnv'>;
  /** explicitly selected real credential store */
  credentialStore?: CredentialStoreLocation;
}

/**
 * resolves a provider's management credential from its declared sources, in
 * explicit reference, process environment, env file, then local store order
 * @param options parsed env file path and local credential policy
 * @param provider provider whose declared credential is read
 * @param selection explicit reference, preloaded sources and store location
 * @returns the credential and where it came from, if any source holds one
 */
export async function resolveProviderCredential(
  options: CommandOptions,
  provider: ProviderId,
  selection: ProviderCredentialSources = {},
): Promise<ProviderCredential> {
  const { reference, credentialStore } = selection;
  if (reference) {
    return {
      token: await resolveSecret(reference, undefined),
      source: `--provider-token-source ${reference}`,
    };
  }
  const { credential } = catalog.providers[provider].prerequisites;
  const sources = selection.sources ?? (await readEnvironmentSources(options));
  const candidates = [
    {
      value: sources.processEnv[credential.environment],
      source: `${credential.environment} in the process environment`,
    },
    {
      value: sources.fileEnv[credential.environment],
      source: `${credential.environment} in ${options.envFile ?? 'the env file'}`,
    },
  ];
  const direct = candidates.find(({ value }) => Boolean(value));
  if (direct) {
    return {
      token: await resolveSecret(undefined, direct.value),
      source: direct.source,
    };
  }
  const stored =
    options.localCredentials === false
      ? undefined
      : await readLocalCredential(credential.store, credentialStore);
  const token = await resolveSecret(undefined, stored);

  return token
    ? {
        token,
        source: `the ${credential.store} credential saved in the local credential store`,
      }
    : {};
}
