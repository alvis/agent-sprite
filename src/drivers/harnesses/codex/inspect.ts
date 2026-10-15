import { AWAKE_COMMAND } from '#integrations/guest/awake';
import {
  isRecord,
  isStringArray,
  readJsonObject,
  readSelectedPlugins,
  readTomlObject,
} from '#integrations/native/configuration';
import { runNativeProbe } from '#integrations/native/probe';
import { runBoundedIO } from '#operation';

import { hasWorkHooks } from '../shared/hooks.js';
import {
  enabledSelections,
  listNativePlugins,
} from '../shared/plugin-state.js';
import { awakeHooksReadiness, proxyReadiness } from '../shared/readiness.js';

import { CODEX_SKILLS_PROBE_MODULE } from './guest-modules.js';
import { CODEX_WORK_HOOKS } from './hooks.js';
import {
  CODEX_CONFIG,
  CODEX_HOME,
  CODEX_HOOKS,
  CODEX_INVENTORY,
  CODEX_PLUGIN_STATE,
} from './paths.js';

import type { TomlTable } from 'smol-toml';

import type {
  HarnessInspection,
  HarnessReadinessContext,
  HarnessSkill,
  HarnessSkillEvidence,
  NativeHarnessInspection,
  ReadinessFinding,
} from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GuestCommandResult } from '#integrations/guest/types';

/**
 * reads Codex configuration, plugin inventory and native skills without a model turn
 * @param guest target guest
 * @returns configuration flags, selected plugins and native skill evidence
 */
export async function inspectCodex(
  guest: GuestChannel,
): Promise<HarnessInspection<HarnessSkillEvidence | undefined>> {
  const [settings, hooks, plugins, selectedPlugins, skills, authenticated] =
    await Promise.all([
      readTomlObject(guest, CODEX_CONFIG),
      readJsonObject(guest, CODEX_HOOKS),
      listNativePlugins(guest, CODEX_INVENTORY),
      readSelectedPlugins(guest, CODEX_PLUGIN_STATE),
      inspectCodexSkills(guest),
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
 * reads native Codex skills with their original plugin identities
 * @param guest target guest
 * @returns validated selected native skill inventory
 */
async function inspectCodexSkills(
  guest: GuestChannel,
): Promise<HarnessSkillEvidence | undefined> {
  const value = await runNativeProbe(guest, CODEX_SKILLS_PROBE_MODULE);
  if (
    !isRecord(value) ||
    !isStringArray(value.selected) ||
    !Array.isArray(value.skills) ||
    !value.skills.every(isCodexSkill)
  ) {
    return undefined;
  }

  return { kind: 'skills', selected: value.selected, skills: value.skills };
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
