import type { OwnedConfigurationValue } from '#adapters/drivers/harnesses/shared/proxy-ownership';

/** Codex configuration fields whose ownership open-agent tracks */
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

/** values open-agent writes into Codex configuration for CLIProxyAPI routing */
export interface CodexManagedValues {
  /** `model_provider` selection */
  modelProvider: string;
  /** provider display name */
  providerName: string;
  /** provider base URL */
  providerBaseUrl: string;
  /** provider wire API */
  providerWireApi: string;
  /** URL of the provider's model catalog */
  providerModelCatalogUrl: string;
  /** command that prints the provider credential */
  authCommand: string;
  /** arguments of the credential command */
  authArgs: string[];
  /** credential command timeout in milliseconds */
  authTimeoutMs: number;
  /** whether native model discovery is enabled */
  modelDiscovery: boolean;
  /** private file holding the credential */
  tokenFile: string;
}

/** ownership evidence for every Codex field open-agent manages */
export type CodexOwnership = Record<
  (typeof CODEX_PROXY_FIELDS)[number],
  OwnedConfigurationValue
>;
