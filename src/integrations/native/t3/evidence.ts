import { normalize } from 'node:path';

import { runGuestResult } from '#integrations/guest';
import { checkOperation, runBoundedIO } from '#operation';

import {
  USER,
  HOME,
  AGENT_PATH,
  isRecord,
  isStringArray,
} from '../configuration.js';
import { installedPlugins } from '../plugin-state.js';

import type { Sprite } from '@fly/sprites';

import type { GuestCommandResult } from '#integrations/guest/types';

export interface ClaudeInitialization {
  modelCount: number;
  commands: string[];
  agents: string[];
  loadedPlugins: string[];
  selectedPluginsLoaded: boolean;
}

/** fresh, scoped provider discovery from the running T3 service */
export interface T3ProviderDiscovery {
  ok: boolean;
  scope: 't3-provider-discovery';
  workspace: '/home/agent';
  providers: Array<{
    instanceId: string;
    driver: 'claudeAgent' | 'codex';
    enabled: boolean;
    installed: boolean;
    status: 'ready' | 'warning' | 'error' | 'disabled';
    checkedAt: string;
    commands: string[];
    skills: Array<{ name: string; path: string; enabled: boolean }>;
  }>;
  limits: {
    ordinaryThreadStartup: 'unverified';
    runtimeHooks: 'unverified';
    mcp: 'unverified';
  };
  reason?: string;
}

/** native Codex app-server skill inventory for selected plugin identities */
export interface CodexNativeSkills {
  selected: string[];
  skills: Array<{
    pluginId: string;
    name: string;
    path: string;
    enabled: boolean;
  }>;
}

type T3Provider = T3ProviderDiscovery['providers'][number];
type T3Skill = T3Provider['skills'][number];
type CodexSkill = CodexNativeSkills['skills'][number];

/**
 * requires every selected identity to remain installed and enabled natively
 * @param result native plugin list result
 * @param harness native harness
 * @param selected managed selected identities
 * @returns whether native inventory confirms all selected plugins
 */
export function enabledSelections(
  result: GuestCommandResult,
  harness: 'claude' | 'codex',
  selected: string[],
): boolean {
  if (result.exitCode !== 0) {
    return false;
  }
  try {
    const enabled = new Set(
      installedPlugins(result.stdout, harness)
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.id),
    );

    return selected.every((identity) => enabled.has(identity));
  } catch {
    return false;
  }
}

/**
 * runs one non-model guest probe and parses a bounded JSON response
 * @param sprite target guest
 * @param filename managed probe script
 * @returns decoded output when the script is installed and parseable
 */
async function runNativeProbe(
  sprite: Sprite,
  filename: string,
): Promise<unknown> {
  const path = `/opt/agent-sprite/${filename}`;
  if (!(await runBoundedIO(async () => sprite.filesystem().exists(path)))) {
    return undefined;
  }
  try {
    const result = await runGuestResult(
      sprite,
      [
        '/usr/sbin/runuser',
        '-u',
        USER,
        '--',
        '/usr/bin/env',
        `PATH=${AGENT_PATH}`,
        '/opt/agent-sprite/node/bin/node',
        path,
      ],
      { timeoutMs: 180_000 },
    );

    return JSON.parse(result.stdout) as unknown;
  } catch {
    checkOperation();

    return undefined;
  }
}

/**
 * reads only the expected non-secret fresh T3 provider fields
 * @param sprite target guest
 * @returns validated service discovery evidence when available
 */
export async function inspectT3Providers(
  sprite: Sprite,
): Promise<T3ProviderDiscovery | undefined> {
  const value = await runNativeProbe(sprite, 't3-provider-probe.js');
  if (
    !isRecord(value) ||
    typeof value.ok !== 'boolean' ||
    value.scope !== 't3-provider-discovery' ||
    value.workspace !== HOME ||
    !isRecord(value.limits) ||
    value.limits.ordinaryThreadStartup !== 'unverified' ||
    value.limits.runtimeHooks !== 'unverified' ||
    value.limits.mcp !== 'unverified' ||
    !Array.isArray(value.providers) ||
    !value.providers.every(isT3Provider)
  ) {
    return undefined;
  }

  return {
    ok: value.ok,
    scope: 't3-provider-discovery',
    workspace: '/home/agent',
    providers: value.providers,
    limits: {
      ordinaryThreadStartup: 'unverified',
      runtimeHooks: 'unverified',
      mcp: 'unverified',
    },
    reason: typeof value.reason === 'string' ? value.reason : undefined,
  };
}

/**
 * validates one narrowed native T3 provider snapshot
 * @param value provider candidate
 * @returns whether the provider has the exact expected shape
 */
function isT3Provider(value: unknown): value is T3Provider {
  return (
    isRecord(value) &&
    (value.driver === 'claudeAgent' || value.driver === 'codex') &&
    typeof value.instanceId === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.installed === 'boolean' &&
    (value.status === 'ready' ||
      value.status === 'warning' ||
      value.status === 'error' ||
      value.status === 'disabled') &&
    typeof value.checkedAt === 'string' &&
    isStringArray(value.commands) &&
    Array.isArray(value.skills) &&
    value.skills.every(isT3Skill)
  );
}

/**
 * validates one narrowed T3 skill identity
 * @param value skill candidate
 * @returns whether exact skill fields are available
 */
function isT3Skill(value: unknown): value is T3Skill {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

/**
 * reads native Codex skills with their original plugin identities
 * @param sprite target guest
 * @returns validated selected native skill inventory
 */
export async function inspectCodexSkills(
  sprite: Sprite,
): Promise<CodexNativeSkills | undefined> {
  const value = await runNativeProbe(sprite, 'codex-skills-probe.js');
  if (
    !isRecord(value) ||
    !isStringArray(value.selected) ||
    !Array.isArray(value.skills) ||
    !value.skills.every(isCodexSkill)
  ) {
    return undefined;
  }

  return { selected: value.selected, skills: value.skills };
}

/**
 * validates one native Codex skill and its originating plugin identity
 * @param value skill candidate
 * @returns whether exact native skill fields are available
 */
function isCodexSkill(value: unknown): value is CodexSkill {
  return (
    isRecord(value) &&
    typeof value.pluginId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

/**
 * matches exact selected Claude commands between the native SDK and T3
 * @param discovery current T3 provider discovery
 * @param initialization native Claude SDK initialization
 * @param selected managed selected identities
 * @returns whether T3 discovers all selected plugin commands
 */
export function verifiesClaudeT3(
  discovery: T3ProviderDiscovery | undefined,
  initialization: ClaudeInitialization | undefined,
  selected: string[],
): boolean {
  const providers = discovery?.providers.filter(
    (provider) =>
      provider.driver === 'claudeAgent' &&
      provider.enabled &&
      provider.installed &&
      provider.status === 'ready',
  );
  if (!discovery?.ok || !providers?.length) {
    return false;
  }
  if (selected.length === 0) {
    return true;
  }
  if (!initialization?.selectedPluginsLoaded) {
    return false;
  }
  const t3Commands = new Set(
    providers.flatMap((provider) => provider.commands),
  );

  return selected.every((identity) => {
    const namespace = `${identity.split('@')[0]}:`;
    const commands = initialization.commands.filter((command) =>
      command.startsWith(namespace),
    );

    return (
      commands.length > 0 &&
      commands.every((command) => t3Commands.has(command))
    );
  });
}

/**
 * matches selected Codex app-server skills to T3 by name, path, and enablement
 * @param discovery current T3 provider discovery
 * @param nativeSkills native Codex app-server skill inventory
 * @param selected managed selected identities
 * @returns whether T3 discovers each selected native skill
 */
export function verifiesCodexT3(
  discovery: T3ProviderDiscovery | undefined,
  nativeSkills: CodexNativeSkills | undefined,
  selected: string[],
): boolean {
  const providers = discovery?.providers.filter(
    (provider) =>
      provider.driver === 'codex' &&
      provider.enabled &&
      provider.installed &&
      provider.status === 'ready',
  );
  if (!discovery?.ok || !providers?.length) {
    return false;
  }
  if (selected.length === 0) {
    return true;
  }
  if (!nativeSkills) {
    return false;
  }
  if (
    selected.length !== nativeSkills.selected.length ||
    !selected.every((identity) => nativeSkills.selected.includes(identity))
  ) {
    return false;
  }
  const t3Skills = providers.flatMap((provider) => provider.skills);

  return selected.every((identity) => {
    const skills = nativeSkills.skills.filter(
      (skill) => skill.pluginId === identity && skill.enabled,
    );

    return (
      skills.length > 0 &&
      skills.every((skill) =>
        t3Skills.some(
          (candidate) =>
            candidate.enabled &&
            candidate.name === skill.name &&
            normalize(candidate.path) === normalize(skill.path),
        ),
      )
    );
  });
}
