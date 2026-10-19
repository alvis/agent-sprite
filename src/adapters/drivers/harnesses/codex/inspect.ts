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
  readTomlObject,
} from '#adapters/guest/platform/native/configuration';
import { isRecord } from '#kernel/guards';
import { checkOperation, runBoundedIO } from '#kernel/operation';

import { withCodexAppServer } from './app-server';
import { CODEX_WORK_HOOKS } from './hooks';
import {
  CODEX_CONFIG,
  CODEX_HOME,
  CODEX_HOOKS,
  CODEX_INVENTORY,
  CODEX_PLUGIN_STATE,
} from './paths';

import type { TomlTable } from 'smol-toml';

import type { GuestCommandResult } from '#adapters/guest/platform/run';
import type { HarnessReadinessContext } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type {
  HarnessInspection,
  NativeHarnessInspection,
  HarnessSkill,
  HarnessSkillEvidence,
} from '#domain/observations/harness';
import type { ReadinessFinding } from '#domain/readiness';

/**
 * reads Codex configuration, plugin inventory and native skills without a model turn
 * @param guest target guest
 * @returns configuration flags, selected plugins and native skill evidence
 */
export async function inspectCodex(
  guest: GuestChannel,
): Promise<HarnessInspection<HarnessSkillEvidence | undefined>> {
  const selection = readSelectedPlugins(guest, CODEX_PLUGIN_STATE);
  const [settings, hooks, plugins, selectedPlugins, skills, authenticated] =
    await Promise.all([
      readTomlObject(guest, CODEX_CONFIG),
      readJsonObject(guest, CODEX_HOOKS),
      listNativePlugins(guest, CODEX_INVENTORY),
      selection,
      selection.then(async (selected) => inspectCodexSkills(guest, selected)),
      runBoundedIO(async () => guest.exists(`${CODEX_HOME}/auth.json`)),
    ] as const);

  return {
    configuration: codexConfiguration({
      settings,
      hooks,
      plugins,
      authenticated,
    }),
    selectedPlugins,
    pluginsEnabled: enabledSelections(
      plugins,
      CODEX_INVENTORY,
      selectedPlugins,
    ),
    evidence: skills,
  };
}

/**
 * evaluates non-secret gateway, discovery, plugin and authentication state
 * @param evidence settings, plugin-list result and native authentication presence
 * @param evidence.settings parsed Codex user configuration
 * @param evidence.hooks parsed Codex user hook definitions
 * @param evidence.plugins native plugin-list command result
 * @param evidence.authenticated whether native credentials exist
 * @returns Codex's configuration flags
 */
function codexConfiguration(evidence: {
  settings: TomlTable;
  hooks: Record<string, unknown>;
  plugins: GuestCommandResult;
  authenticated: boolean;
}): NativeHarnessInspection {
  const { settings, hooks, plugins, authenticated } = evidence;
  const providers = isRecord(settings.model_providers)
    ? settings.model_providers
    : {};
  const proxy = isRecord(providers.cliproxyapi) ? providers.cliproxyapi : {};
  const features = isRecord(settings.features) ? settings.features : {};
  const isProxyConfigured =
    settings.model_provider === 'cliproxyapi' &&
    proxy.wire_api === 'responses' &&
    typeof proxy.base_url === 'string';
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
      features.api_key_model_discovery === true &&
      typeof proxy.model_catalog_url === 'string',
    pluginListAvailable: plugins.exitCode === 0,
    awakeHooksInstalled: hasWorkHooks(hooks.hooks, {
      owned: CODEX_WORK_HOOKS,
      command: { program: AWAKE_COMMAND },
    }),
    authentication,
  };
}

/**
 * lists the skills Codex loaded in the agent's home, through its app server,
 * keeping those of the selected plugins with their original identities
 * @param guest target guest
 * @param selected plugin identities open-agent selected
 * @returns validated selected native skill inventory, absent when Codex could not list it
 */
async function inspectCodexSkills(
  guest: GuestChannel,
  selected: readonly string[],
): Promise<HarnessSkillEvidence | undefined> {
  let result: Record<string, unknown>;
  try {
    result = await withCodexAppServer(guest, async (request) =>
      request('skills/list', { cwds: [HOME], forceReload: true }),
    );
  } catch {
    checkOperation();

    return undefined;
  }
  const workspace = Array.isArray(result.data)
    ? result.data.filter(isRecord).find((item) => item.cwd === HOME)
    : undefined;
  if (!workspace || !Array.isArray(workspace.skills)) {
    return undefined;
  }
  const skills = workspace.skills.filter(
    (skill) =>
      isRecord(skill) &&
      typeof skill.pluginId === 'string' &&
      selected.includes(skill.pluginId),
  );
  if (!skills.every(isCodexSkill)) {
    return undefined;
  }

  return {
    kind: 'skills',
    selected: [...selected],
    skills: skills.map(({ pluginId, name, path, enabled }) => ({
      pluginId,
      name,
      path,
      enabled,
    })),
  };
}

/**
 * validates one native Codex skill and its originating plugin identity
 * @param value skill candidate
 * @returns whether exact native skill fields are available
 */
function isCodexSkill(value: unknown): value is HarnessSkill {
  return (
    isRecord(value) &&
    typeof value.pluginId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

/**
 * derives Codex's gateway readiness from gathered native evidence
 * @param inspection native configuration evidence, absent when inspection failed
 * @param context facts the checks depend on
 * @returns gateway, model-discovery and awake-hook findings
 */
export function codexReadiness(
  inspection: NativeHarnessInspection | undefined,
  context: HarnessReadinessContext,
): ReadinessFinding[] {
  return [
    ...proxyReadiness('Codex', inspection, context),
    awakeHooksReadiness('Codex', inspection),
  ];
}
