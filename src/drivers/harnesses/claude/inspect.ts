import { GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';
import { runGuestResult } from '#integrations/guest';
import { AWAKE_COMMAND } from '#integrations/guest/awake';
import {
  AGENT_PATH,
  HOME,
  asAgent,
  isRecord,
  isStringArray,
  readJsonObject,
  readSelectedPlugins,
} from '#integrations/native/configuration';
import { runBoundedIO } from '#operation';

import { hasWorkHooks } from '../shared/hooks.js';
import {
  enabledSelections,
  listNativePlugins,
} from '../shared/plugin-state.js';
import { awakeHooksReadiness, proxyReadiness } from '../shared/readiness.js';

import { CLAUDE_INIT_PROBE_MODULE } from './guest-modules.js';
import { CLAUDE_WORK_HOOKS } from './hooks.js';
import {
  CLAUDE_INVENTORY,
  CLAUDE_PLUGIN_STATE,
  CLAUDE_SETTINGS,
} from './paths.js';

import type {
  HarnessCommandEvidence,
  HarnessInspection,
  HarnessReadinessContext,
  NativeHarnessInspection,
  ReadinessFinding,
} from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GuestCommandResult } from '#integrations/guest/types';

const INITIALIZATION_PROBE_TIMEOUT_MS = 45_000;
const INITIALIZATION_PROBE = `${GUEST_ROOT}/${CLAUDE_INIT_PROBE_MODULE}`;

/** what the Claude SDK reports after loading the managed settings */
export interface ClaudeInitialization extends HarnessCommandEvidence {
  /** number of models the SDK offers */
  modelCount: number;
  /** agents the SDK registered */
  agents: string[];
  /** plugins the SDK loaded */
  loadedPlugins: string[];
}

/**
 * reads Claude settings, plugin inventory and SDK initialization without a model turn
 * @param guest target guest
 * @returns configuration flags, selected plugins and initialization evidence
 */
export async function inspectClaude(
  guest: GuestChannel,
): Promise<HarnessInspection<ClaudeInitialization | undefined>> {
  const [settings, plugins, initialization, selectedPlugins, authenticated] =
    await Promise.all([
      readJsonObject(guest, CLAUDE_SETTINGS),
      listNativePlugins(guest, CLAUDE_INVENTORY),
      inspectClaudeInitialization(guest),
      readSelectedPlugins(guest, CLAUDE_PLUGIN_STATE),
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
  let authentication: NativeHarnessInspection['authentication'] =
    'not-configured';
  if (isProxyConfigured) {
    authentication = 'managed-proxy';
  } else if (authenticated) {
    authentication = 'native';
  }

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
 * asks the pinned SDK to report actual Claude initialization data
 * @param guest target guest
 * @returns native initialization evidence when available
 */
async function inspectClaudeInitialization(
  guest: GuestChannel,
): Promise<ClaudeInitialization | undefined> {
  if (!(await runBoundedIO(async () => guest.exists(INITIALIZATION_PROBE)))) {
    return undefined;
  }
  const result = await runGuestResult(
    guest,
    asAgent([
      '/usr/bin/env',
      `PATH=${AGENT_PATH}`,
      GUEST_NODE,
      INITIALIZATION_PROBE,
    ]),
    { timeoutMs: INITIALIZATION_PROBE_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const response: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(response) ||
    response.initialized !== true ||
    typeof response.modelCount !== 'number' ||
    !isStringArray(response.commands) ||
    !isStringArray(response.agents) ||
    !isStringArray(response.loadedPlugins) ||
    typeof response.selectedPluginsLoaded !== 'boolean'
  ) {
    return undefined;
  }

  return {
    kind: 'commands',
    modelCount: response.modelCount,
    commands: response.commands,
    agents: response.agents,
    loadedPlugins: response.loadedPlugins,
    selectedPluginsLoaded: response.selectedPluginsLoaded,
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
