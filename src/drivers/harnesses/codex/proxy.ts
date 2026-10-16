import { stringify } from 'smol-toml';

import { resolveProxyEndpoints } from '#drivers/shared/cliproxyapi/endpoints';
import { CommandFault } from '#errors';

import { writeOwnedFile } from '#integrations/guest/account';

import {
  proxyOwnershipPath,
  readOwnershipRecord,
  removeOwnershipRecord,
  restoreOwnedFile,
  restoreOwnedValue,
  sameValue,
  writeOwnershipRecord,
} from '../shared/proxy-ownership.js';

import {
  captureCodexOwnership,
  isTomlTable,
  isTomlValue,
} from './ownership.js';
import { CODEX_CONFIG, CODEX_TOKEN } from './paths.js';
import { CODEX_PROXY_FIELDS } from './types.js';

import type { TomlTable } from 'smol-toml';

import type { ProxyRoute } from '#drivers/contracts';

import type {
  OwnedConfigurationValue,
  NativeProxyParams,
} from '../shared/proxy-ownership.js';

import type { CodexManagedValues, CodexOwnership } from './types.js';

const CODEX_PROXY_OWNERSHIP = proxyOwnershipPath('codex');

/**
 * configures or narrowly removes manager-owned Codex proxy routing
 * @param params native proxy settings
 * @param params.guest target guest channel
 * @param params.current current native settings
 * @param params.proxy optional CLIProxyAPI route
 */
export async function configureCodexProxy({
  guest,
  current,
  proxy,
}: NativeProxyParams<TomlTable>): Promise<void> {
  const ownership = await readOwnershipRecord(
    guest,
    CODEX_PROXY_OWNERSHIP,
    CODEX_PROXY_FIELDS,
  );
  if (proxy) {
    const providers = isTomlTable(current.model_providers)
      ? current.model_providers
      : {};
    const provider = isTomlTable(providers.cliproxyapi)
      ? providers.cliproxyapi
      : {};
    if (provider.env_key || provider.experimental_bearer_token) {
      throw new CommandFault({
        code: 'CONFLICT',
        message:
          'Codex CLIProxyAPI provider has a conflicting authentication mechanism',
      });
    }
    const values = managedValues(proxy);
    const fields = await captureCodexOwnership({
      guest,
      current,
      values,
      ownership,
    });
    await writeOwnershipRecord(guest, CODEX_PROXY_OWNERSHIP, fields);
    await writeOwnedFile(guest, CODEX_TOKEN, values.tokenFile);
    await writeOwnedFile(
      guest,
      CODEX_CONFIG,
      stringify(managedConfiguration(current, values)),
    );

    return;
  }
  if (!ownership) {
    return;
  }
  await writeOwnedFile(
    guest,
    CODEX_CONFIG,
    stringify(restoredConfiguration(current, ownership)),
  );
  await restoreOwnedFile(guest, CODEX_TOKEN, ownership.tokenFile);
  await removeOwnershipRecord(guest, CODEX_PROXY_OWNERSHIP);
}

/**
 * constructs the exact managed Codex proxy values
 * @param proxy CLIProxyAPI route
 * @returns values written into native configuration and the token file
 */
function managedValues(proxy: ProxyRoute): CodexManagedValues {
  const endpoints = resolveProxyEndpoints(proxy.url);

  return {
    modelProvider: 'cliproxyapi',
    providerName: 'CLIProxyAPI',
    providerBaseUrl: endpoints.versioned,
    providerWireApi: 'responses',
    providerModelCatalogUrl: endpoints.models,
    authCommand: '/usr/bin/cat',
    authArgs: [CODEX_TOKEN],
    authTimeoutMs: 5_000,
    modelDiscovery: true,
    tokenFile: `${proxy.apiKey}\n`,
  };
}

/**
 * applies managed values while preserving unrelated Codex configuration
 * @param current current Codex configuration
 * @param values exact manager-owned values
 * @returns configuration with managed routing enabled
 */
function managedConfiguration(
  current: TomlTable,
  values: CodexManagedValues,
): TomlTable {
  const providers = isTomlTable(current.model_providers)
    ? current.model_providers
    : {};
  const provider = isTomlTable(providers.cliproxyapi)
    ? providers.cliproxyapi
    : {};
  const auth = isTomlTable(provider.auth) ? provider.auth : {};
  const features = isTomlTable(current.features) ? current.features : {};

  return {
    ...current,
    model_provider: values.modelProvider,
    model_providers: {
      ...providers,
      cliproxyapi: {
        ...provider,
        name: values.providerName,
        base_url: values.providerBaseUrl,
        wire_api: values.providerWireApi,
        model_catalog_url: values.providerModelCatalogUrl,
        auth: {
          ...auth,
          command: values.authCommand,
          args: values.authArgs,
          timeout_ms: values.authTimeoutMs,
        },
      },
    },
    features: {
      ...features,
      api_key_model_discovery: values.modelDiscovery,
    },
  };
}

/**
 * restores unchanged manager-owned fields while preserving unrelated values
 * @param current current Codex configuration
 * @param ownership original and last manager-written values
 * @returns configuration with narrow manager cleanup applied
 */
function restoredConfiguration(
  current: TomlTable,
  ownership: CodexOwnership,
): TomlTable {
  const top = restoreModelProvider(current, ownership);
  if (isTomlTable(top.model_providers)) {
    const modelProviders = restoreModelProviders(
      top.model_providers,
      ownership,
    );
    if (
      modelProviders &&
      (Object.keys(modelProviders).length > 0 ||
        ownership.providersContainer.previousPresent)
    ) {
      top.model_providers = modelProviders;
    } else {
      delete top.model_providers;
    }
  }
  if (isTomlTable(top.features)) {
    const features = restoreTomlValue(
      top.features,
      'api_key_model_discovery',
      ownership.modelDiscovery,
    );
    if (
      Object.keys(features).length > 0 ||
      ownership.featuresContainer.previousPresent
    ) {
      top.features = features;
    } else {
      delete top.features;
    }
  }

  return top;
}

/**
 * restores the top-level provider selection
 * @param current current Codex configuration
 * @param ownership original and managed values
 * @returns cloned configuration with narrow restoration applied
 */
function restoreModelProvider(
  current: TomlTable,
  ownership: CodexOwnership,
): TomlTable {
  const restored: TomlTable = { ...current };
  const modelProvider = ownership.modelProvider;
  if (sameValue(current.model_provider, modelProvider.managedValue)) {
    if (
      modelProvider.previousPresent &&
      typeof modelProvider.previousValue === 'string'
    ) {
      restored.model_provider = modelProvider.previousValue;
    } else {
      delete restored.model_provider;
    }
  }

  return restored;
}

/**
 * restores manager-owned fields within the CLIProxyAPI provider
 * @param value current model-provider table
 * @param ownership original and managed values
 * @returns restored provider table when the current table remains present
 */
function restoreModelProviders(
  value: TomlTable,
  ownership: CodexOwnership,
): TomlTable | undefined {
  const providers = { ...value };
  const provider = isTomlTable(providers.cliproxyapi)
    ? { ...providers.cliproxyapi }
    : undefined;
  if (!provider) {
    return providers;
  }
  const restoredProvider = restoreTomlValue(
    restoreTomlValue(
      restoreTomlValue(
        restoreTomlValue(provider, 'name', ownership.providerName),
        'base_url',
        ownership.providerBaseUrl,
      ),
      'wire_api',
      ownership.providerWireApi,
    ),
    'model_catalog_url',
    ownership.providerModelCatalogUrl,
  );
  const nextProvider = { ...restoredProvider };
  if (isTomlTable(provider.auth)) {
    const auth = restoreProviderAuth(provider.auth, ownership);
    if (
      Object.keys(auth).length > 0 ||
      ownership.authContainer.previousPresent
    ) {
      nextProvider.auth = auth;
    } else {
      delete nextProvider.auth;
    }
  }
  if (
    Object.keys(nextProvider).length === 0 &&
    !ownership.providerContainer.previousPresent
  ) {
    delete providers.cliproxyapi;

    return Object.keys(providers).length > 0 ||
      ownership.providersContainer.previousPresent
      ? providers
      : undefined;
  }

  return { ...providers, cliproxyapi: nextProvider };
}

/**
 * restores manager-owned fields in the provider authentication table
 * @param value current authentication table
 * @param ownership original and managed values
 * @returns restored authentication table when present
 */
function restoreProviderAuth(
  value: TomlTable,
  ownership: CodexOwnership,
): TomlTable {
  return restoreTomlValue(
    restoreTomlValue(
      restoreTomlValue(value, 'command', ownership.authCommand),
      'args',
      ownership.authArgs,
    ),
    'timeout_ms',
    ownership.authTimeoutMs,
  );
}

/**
 * restores one TOML field only while its current value remains manager-owned
 * @param current current containing table
 * @param key managed field name
 * @param ownership original and last managed values
 * @returns cloned table with narrow restoration applied
 */
function restoreTomlValue(
  current: TomlTable,
  key: string,
  ownership: OwnedConfigurationValue,
): TomlTable {
  return restoreOwnedValue(current, key, {
    ownership,
    acceptsPreviousValue: isTomlValue,
  });
}
