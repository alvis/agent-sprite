import { guestFileExists, readGuestFile } from '#integrations/guest';

import { isRecord } from '#integrations/native/configuration';

import { captureOrRefreshOwnedValue } from '../shared/proxy-ownership.js';

import { CODEX_TOKEN } from './paths.js';

import type { TomlTable, TomlValue } from 'smol-toml';

import type { GuestChannel } from '#drivers/guest-channel';

import type { OwnedConfigurationValue } from '../shared/proxy-ownership.js';

import type { CodexManagedValues, CodexOwnership } from './types.js';

/** inputs for capturing every managed Codex field */
interface CaptureParams {
  /** target guest */
  guest: GuestChannel;
  /** current Codex configuration */
  current: TomlTable;
  /** values about to be written */
  values: CodexManagedValues;
  /** previously recorded ownership evidence */
  ownership?: CodexOwnership;
}

/** inputs for capturing one managed field of a table */
interface FieldParams {
  /** previously recorded ownership evidence */
  ownership?: CodexOwnership;
  /** ownership record the field belongs to */
  ownershipKey: keyof CodexOwnership;
  /** table that holds the field */
  current: Record<string, unknown>;
  /** field name within the table */
  key: string;
  /** value about to be written */
  managedValue: unknown;
}

/** inputs for capturing the fields of the managed provider table */
interface ProviderCaptureParams {
  /** previously recorded ownership evidence */
  ownership?: CodexOwnership;
  /** current Codex configuration */
  current: TomlTable;
  /** the managed provider table */
  provider: Record<string, unknown>;
  /** values about to be written */
  values: CodexManagedValues;
}

/**
 * captures original Codex values before the first managed write
 * @param params current configuration, managed values, and prior evidence
 * @returns original and last managed values for every changed field
 */
export async function captureCodexOwnership(
  params: CaptureParams,
): Promise<CodexOwnership> {
  const { guest, current, values, ownership } = params;
  const providersPresent = isRecord(current.model_providers);
  const providers = isRecord(current.model_providers)
    ? current.model_providers
    : {};
  const providerPresent = isRecord(providers.cliproxyapi);
  const provider = isRecord(providers.cliproxyapi) ? providers.cliproxyapi : {};
  const authPresent = isRecord(provider.auth);
  const auth = isRecord(provider.auth) ? provider.auth : {};
  const featuresPresent = isRecord(current.features);
  const features = isRecord(current.features) ? current.features : {};
  const tokenPresent = await guestFileExists(guest, CODEX_TOKEN);
  const token = tokenPresent
    ? await readGuestFile(guest, CODEX_TOKEN)
    : undefined;

  return {
    providersContainer: containerField(
      ownership,
      'providersContainer',
      providersPresent,
    ),
    providerContainer: containerField(
      ownership,
      'providerContainer',
      providerPresent,
    ),
    authContainer: containerField(ownership, 'authContainer', authPresent),
    featuresContainer: containerField(
      ownership,
      'featuresContainer',
      featuresPresent,
    ),
    ...captureProviderFields({ ownership, current, provider, values }),
    ...captureAuthFields(ownership, auth, values),
    modelDiscovery: field({
      ownership,
      ownershipKey: 'modelDiscovery',
      current: features,
      key: 'api_key_model_discovery',
      managedValue: values.modelDiscovery,
    }),
    tokenFile: field({
      ownership,
      ownershipKey: 'tokenFile',
      current: tokenPresent ? { contents: token } : {},
      key: 'contents',
      managedValue: values.tokenFile,
    }),
  };
}

/**
 * records whether a manager-created TOML container previously existed
 * @param ownership prior ownership evidence
 * @param key container ownership field name
 * @param wasPresent whether the native container already existed
 * @returns container-presence ownership evidence
 */
function containerField(
  ownership: CaptureParams['ownership'],
  key: keyof CodexOwnership,
  wasPresent: boolean,
): OwnedConfigurationValue {
  return field({
    ownership,
    ownershipKey: key,
    current: wasPresent ? { present: true } : {},
    key: 'present',
    managedValue: true,
  });
}

/**
 * captures top-level and provider-table ownership fields
 * @param params current tables, managed values, and prior evidence
 * @returns provider ownership fields
 */
function captureProviderFields(
  params: ProviderCaptureParams,
): Pick<
  CodexOwnership,
  | 'modelProvider'
  | 'providerName'
  | 'providerBaseUrl'
  | 'providerWireApi'
  | 'providerModelCatalogUrl'
> {
  const { ownership, current, provider, values } = params;

  return {
    modelProvider: field({
      ownership,
      ownershipKey: 'modelProvider',
      current,
      key: 'model_provider',
      managedValue: values.modelProvider,
    }),
    providerName: field({
      ownership,
      ownershipKey: 'providerName',
      current: provider,
      key: 'name',
      managedValue: values.providerName,
    }),
    providerBaseUrl: field({
      ownership,
      ownershipKey: 'providerBaseUrl',
      current: provider,
      key: 'base_url',
      managedValue: values.providerBaseUrl,
    }),
    providerWireApi: field({
      ownership,
      ownershipKey: 'providerWireApi',
      current: provider,
      key: 'wire_api',
      managedValue: values.providerWireApi,
    }),
    providerModelCatalogUrl: field({
      ownership,
      ownershipKey: 'providerModelCatalogUrl',
      current: provider,
      key: 'model_catalog_url',
      managedValue: values.providerModelCatalogUrl,
    }),
  };
}

/**
 * captures managed provider-authentication ownership fields
 * @param ownership prior ownership evidence
 * @param auth current provider authentication table
 * @param values next managed values
 * @returns authentication ownership fields
 */
function captureAuthFields(
  ownership: CaptureParams['ownership'],
  auth: Record<string, unknown>,
  values: CodexManagedValues,
): Pick<CodexOwnership, 'authCommand' | 'authArgs' | 'authTimeoutMs'> {
  return {
    authCommand: field({
      ownership,
      ownershipKey: 'authCommand',
      current: auth,
      key: 'command',
      managedValue: values.authCommand,
    }),
    authArgs: field({
      ownership,
      ownershipKey: 'authArgs',
      current: auth,
      key: 'args',
      managedValue: values.authArgs,
    }),
    authTimeoutMs: field({
      ownership,
      ownershipKey: 'authTimeoutMs',
      current: auth,
      key: 'timeout_ms',
      managedValue: values.authTimeoutMs,
    }),
  };
}

/**
 * captures or refreshes one ownership field
 * @param params current field, next value, and prior evidence
 * @returns original and last managed values
 */
function field(params: FieldParams): OwnedConfigurationValue {
  const { ownership, ownershipKey, current, key, managedValue } = params;

  return captureOrRefreshOwnedValue({
    ownership: ownership?.[ownershipKey],
    current,
    key,
    managedValue,
  });
}

/**
 * narrows parsed native configuration objects to TOML tables
 * @param value candidate table
 * @returns true for a TOML-compatible table
 */
export function isTomlTable(value: unknown): value is TomlTable {
  return isRecord(value) && Object.values(value).every(isTomlValue);
}

/**
 * validates JSON-persisted values before restoring them into TOML
 * @param value candidate TOML value
 * @returns true for a TOML-compatible value
 */
export function isTomlValue(value: unknown): value is TomlValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every(isTomlValue)) ||
    isTomlTable(value)
  );
}
