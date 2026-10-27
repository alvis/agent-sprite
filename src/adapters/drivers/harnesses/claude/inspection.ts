import { hasWorkHooks } from '#adapters/drivers/harnesses/shared/hooks';
import {
  enabledSelections,
  listNativePlugins,
} from '#adapters/drivers/harnesses/shared/plugin-state';
import {
  awakeHooksReadiness,
  proxyReadiness,
} from '#adapters/drivers/harnesses/shared/readiness';
import { HOME } from '#adapters/guest/platform/account';
import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import {
  readJsonObject,
  readSelectedPlugins,
} from '#adapters/guest/platform/native/configuration';
import { isRecord } from '#kernel/guards';
import { runBoundedIO } from '#kernel/operation';

import { CLAUDE_WORK_HOOKS } from './hooks';
import { inspectClaudeInitialization } from './initialization';
import {
  CLAUDE_INVENTORY,
  CLAUDE_PLUGIN_STATE,
  CLAUDE_SETTINGS,
} from './paths';

import type { GuestCommandResult } from '#adapters/guest/platform/run';
import type { HarnessReadinessContext } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type {
  HarnessInspection,
  NativeHarnessInspection,
} from '#domain/observations/harness';
import type { ReadinessFinding } from '#domain/readiness';

import type { ClaudeInitialization } from './initialization';

/**
 * reads Claude settings, plugin inventory and SDK initialization without a model turn
 * @param guest target guest
 * @returns configuration flags, selected plugins and initialization evidence
 */
export async function inspectClaude(
  guest: GuestChannel,
): Promise<HarnessInspection<ClaudeInitialization | undefined>> {
  const selection = readSelectedPlugins(guest, CLAUDE_PLUGIN_STATE);
  const [settings, plugins, initialization, selectedPlugins, authenticated] =
    await Promise.all([
      readJsonObject(guest, CLAUDE_SETTINGS),
      listNativePlugins(guest, CLAUDE_INVENTORY),
      selection.then(async (selected) =>
        inspectClaudeInitialization(guest, selected),
      ),
      selection,
      runBoundedIO(async () =>
        guest.exists(`${HOME}/.claude/.credentials.json`),
      ),
    ] as const);

  return {
    configuration: claudeConfiguration({ settings, plugins, authenticated }),
    selectedPlugins,
    pluginsEnabled: enabledSelections(
      plugins,
      CLAUDE_INVENTORY,
      selectedPlugins,
    ),
    evidence: initialization,
  };
}

/**
 * evaluates non-secret gateway, discovery, plugin and authentication state
 * @param evidence settings, plugin-list result and native authentication presence
 * @param evidence.settings parsed Claude user settings
 * @param evidence.plugins native plugin-list command result
 * @param evidence.authenticated whether native credentials exist
 * @returns Claude's configuration flags
 */
function claudeConfiguration(evidence: {
  settings: Record<string, unknown>;
  plugins: GuestCommandResult;
  authenticated: boolean;
}): NativeHarnessInspection {
  const { settings, plugins, authenticated } = evidence;
  const env = isRecord(settings.env) ? settings.env : {};
  const isProxyConfigured =
    typeof env.ANTHROPIC_BASE_URL === 'string' &&
    typeof env.ANTHROPIC_AUTH_TOKEN === 'string';
  const authentication: NativeHarnessInspection['authentication'] =
    isProxyConfigured
      ? 'managed-proxy'
      : authenticated
        ? 'native'
        : 'not-configured';

  return {
    gatewayConfigured: isProxyConfigured,
    modelDiscoveryEnabled:
      env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '1',
    pluginListAvailable: plugins.exitCode === 0,
    awakeHooksInstalled: hasWorkHooks(settings.hooks, {
      owned: CLAUDE_WORK_HOOKS,
      command: { program: AWAKE_COMMAND },
    }),
    authentication,
  };
}

/**
 * derives Claude's gateway readiness from gathered native evidence
 * @param inspection native configuration evidence, absent when inspection failed
 * @param context facts the checks depend on
 * @returns gateway, model-discovery and awake-hook findings
 */
export function claudeReadiness(
  inspection: NativeHarnessInspection | undefined,
  context: HarnessReadinessContext,
): ReadinessFinding[] {
  return [
    ...proxyReadiness('Claude', inspection, context),
    awakeHooksReadiness('Claude', inspection),
  ];
}
