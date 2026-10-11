import { isRecord } from '#utilities/guards';

import type { TomlTable } from 'smol-toml';

import type { GuestCommandResult } from '#integrations/guest/types';

import type { NativeHarnessInspection } from './types.js';

/** native settings and authentication facts needed for bounded inspection */
export interface NativeConfigurationEvidence {
  claude: Record<string, unknown>;
  codex: TomlTable;
  claudePlugins: GuestCommandResult;
  codexPlugins: GuestCommandResult;
  claudeNativeAuthentication: boolean;
  codexNativeAuthentication: boolean;
}

/**
 * evaluates non-secret gateway, discovery, plugin, and authentication state
 * @param evidence native settings and authentication evidence
 * @returns configuration flags for both native harnesses
 */
export function inspectNativeConfigurationFlags(
  evidence: NativeConfigurationEvidence,
): { claude: NativeHarnessInspection; codex: NativeHarnessInspection } {
  const { claude, codex, claudePlugins, codexPlugins } = evidence;
  const claudeEnv = isRecord(claude.env) ? claude.env : {};
  const providers = isRecord(codex.model_providers)
    ? codex.model_providers
    : {};
  const proxy = isRecord(providers.cliproxyapi) ? providers.cliproxyapi : {};
  const features = isRecord(codex.features) ? codex.features : {};
  const isClaudeProxyConfigured =
    typeof claudeEnv.ANTHROPIC_BASE_URL === 'string' &&
    typeof claudeEnv.ANTHROPIC_AUTH_TOKEN === 'string';
  const isCodexProxyConfigured =
    codex.model_provider === 'cliproxyapi' &&
    proxy.wire_api === 'responses' &&
    typeof proxy.base_url === 'string';

  return {
    claude: {
      gatewayConfigured: isClaudeProxyConfigured,
      modelDiscoveryEnabled:
        claudeEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '1',
      pluginListAvailable: claudePlugins.exitCode === 0,
      authentication: isClaudeProxyConfigured
        ? 'managed-proxy'
        : evidence.claudeNativeAuthentication
          ? 'native'
          : 'not-configured',
    },
    codex: {
      gatewayConfigured: isCodexProxyConfigured,
      modelDiscoveryEnabled:
        features.api_key_model_discovery === true &&
        typeof proxy.model_catalog_url === 'string',
      pluginListAvailable: codexPlugins.exitCode === 0,
      authentication: isCodexProxyConfigured
        ? 'managed-proxy'
        : evidence.codexNativeAuthentication
          ? 'native'
          : 'not-configured',
    },
  };
}
