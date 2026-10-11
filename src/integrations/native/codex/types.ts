import type { OwnedConfigurationValue } from '../proxy-ownership.js';

export const CODEX_PROXY_FIELDS = [
  'providersContainer',
  'providerContainer',
  'authContainer',
  'featuresContainer',
  'modelProvider',
  'providerName',
  'providerBaseUrl',
  'providerWireApi',
  'providerModelCatalogUrl',
  'authCommand',
  'authArgs',
  'authTimeoutMs',
  'modelDiscovery',
  'tokenFile',
] as const;

export interface CodexManagedValues {
  modelProvider: string;
  providerName: string;
  providerBaseUrl: string;
  providerWireApi: string;
  providerModelCatalogUrl: string;
  authCommand: string;
  authArgs: string[];
  authTimeoutMs: number;
  modelDiscovery: boolean;
  tokenFile: string;
}

export type CodexOwnership = Record<
  (typeof CODEX_PROXY_FIELDS)[number],
  OwnedConfigurationValue
>;
