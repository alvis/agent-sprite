import { runGuestResult } from '#integrations/guest';
import { runOperation, runBoundedIO } from '#operation';
import { rememberSecret } from '#utilities/redaction';

import {
  USER,
  HOME,
  AGENT_PATH,
  CLAUDE_SETTINGS,
  CLAUDE_PLUGIN_STATE,
  CODEX_PLUGIN_STATE,
  CODEX_CONFIG,
  isRecord,
  isStringArray,
  readJsonObject,
  readTomlObject,
  readSelectedPlugins,
  runAsAgent,
} from './configuration.js';
import {
  enabledSelections,
  inspectCodexSkills,
  inspectT3Providers,
  verifiesClaudeT3,
  verifiesCodexT3,
} from './t3/evidence.js';
import { inspectNativeConfigurationFlags } from './t3/inspection.js';

import type { Sprite } from '@fly/sprites';

import type { GuestCommandResult } from '#integrations/guest/types';

import type {
  ClaudeInitialization,
  CodexNativeSkills,
  T3ProviderDiscovery,
} from './t3/evidence.js';

import type { NativeHarnessInspection } from './t3/types.js';

/** genuine new native T3 pairing result; token and raw output are sensitive */
export interface T3Pairing {
  token: string;
  expiresAt?: string;
  raw: string;
}

/** current non-secret native configuration state for explicit inspection */
export interface NativeConfigurationInspection {
  claude: NativeHarnessInspection;
  codex: NativeHarnessInspection;
  t3ClaudePluginLoading: 'verified' | 'not-verified';
  t3CodexPluginLoading: 'verified' | 'not-verified';
  t3ProviderDiscovery?: T3ProviderDiscovery;
  codexNativeSkills?: CodexNativeSkills;
  claudeSdkPluginLoading: 'verified' | 'not-verified';
  selectedClaudePlugins: string[];
  selectedCodexPlugins: string[];
  claudeSdkInitialization?: {
    modelCount: number;
    commands: string[];
    agents: string[];
    loadedPlugins: string[];
  };
}

export type { NativeHarnessInspection } from './t3/types.js';

interface NativeInspectionEvidence {
  claude: Record<string, unknown>;
  codex: Awaited<ReturnType<typeof readTomlObject>>;
  claudePlugins: GuestCommandResult;
  codexPlugins: GuestCommandResult;
  initialization?: ClaudeInitialization;
  selectedClaudePlugins: string[];
  selectedCodexPlugins: string[];
  discovery?: T3ProviderDiscovery;
  codexSkills?: CodexNativeSkills;
  claudeNativeAuthentication: boolean;
  codexNativeAuthentication: boolean;
}

/**
 * reads native user settings and validates native plugin-list commands without a model turn
 * @param sprite target guest
 * @returns current non-secret native settings and loading evidence
 */
export async function inspectNativeConfiguration(
  sprite: Sprite,
): Promise<NativeConfigurationInspection> {
  const evidence = await readNativeInspectionEvidence(sprite);
  const {
    claudePlugins,
    codexPlugins,
    initialization,
    selectedClaudePlugins,
    selectedCodexPlugins,
    discovery,
    codexSkills,
  } = evidence;
  const claudeEnabled = enabledSelections(
    claudePlugins,
    'claude',
    selectedClaudePlugins,
  );
  const codexEnabled = enabledSelections(
    codexPlugins,
    'codex',
    selectedCodexPlugins,
  );

  return {
    ...inspectNativeConfigurationFlags(evidence),
    t3ClaudePluginLoading:
      claudeEnabled &&
      verifiesClaudeT3(discovery, initialization, selectedClaudePlugins)
        ? 'verified'
        : 'not-verified',
    t3CodexPluginLoading:
      codexEnabled &&
      verifiesCodexT3(discovery, codexSkills, selectedCodexPlugins)
        ? 'verified'
        : 'not-verified',
    t3ProviderDiscovery: discovery,
    codexNativeSkills: codexSkills,
    ...claudeSdkEvidence(initialization, selectedClaudePlugins),
    selectedClaudePlugins,
    selectedCodexPlugins,
  };
}

/**
 * gathers independent native configuration, plugin, and authentication evidence
 * @param sprite target guest
 * @returns current bounded evidence without a model turn
 */
async function readNativeInspectionEvidence(
  sprite: Sprite,
): Promise<NativeInspectionEvidence> {
  const values = await runOperation(async () =>
    Promise.all([
      readJsonObject(sprite, CLAUDE_SETTINGS),
      readTomlObject(sprite, CODEX_CONFIG),
      listNativePlugins(sprite, 'claude'),
      listNativePlugins(sprite, 'codex'),
      inspectClaudeInitialization(sprite),
      readSelectedPlugins(sprite, CLAUDE_PLUGIN_STATE),
      readSelectedPlugins(sprite, CODEX_PLUGIN_STATE),
      inspectT3Providers(sprite),
      inspectCodexSkills(sprite),
      runBoundedIO(async () =>
        sprite.filesystem().exists(`${HOME}/.claude/.credentials.json`),
      ),
      runBoundedIO(async () =>
        sprite.filesystem().exists(`${HOME}/.codex/auth.json`),
      ),
    ] as const),
  );
  const [
    claude,
    codex,
    claudePlugins,
    codexPlugins,
    initialization,
    selectedClaudePlugins,
    selectedCodexPlugins,
    discovery,
    codexSkills,
    claudeNativeAuthentication,
    codexNativeAuthentication,
  ] = values;

  return {
    claude,
    codex,
    claudePlugins,
    codexPlugins,
    initialization,
    selectedClaudePlugins,
    selectedCodexPlugins,
    discovery,
    codexSkills,
    claudeNativeAuthentication,
    codexNativeAuthentication,
  };
}

/**
 * narrows the standalone Claude SDK probe without implying T3 loading
 * @param initialization native SDK initialization evidence
 * @param selected managed Claude plugin identities
 * @returns non-secret SDK evidence fields
 */
function claudeSdkEvidence(
  initialization: ClaudeInitialization | undefined,
  selected: string[],
): Pick<
  NativeConfigurationInspection,
  'claudeSdkPluginLoading' | 'claudeSdkInitialization'
> {
  return {
    claudeSdkPluginLoading:
      initialization &&
      (selected.length === 0 || initialization.selectedPluginsLoaded)
        ? 'verified'
        : 'not-verified',
    claudeSdkInitialization: initialization
      ? {
          modelCount: initialization.modelCount,
          commands: initialization.commands,
          agents: initialization.agents,
          loadedPlugins: initialization.loadedPlugins,
        }
      : undefined,
  };
}

/**
 * probes native plugin-list availability without changing native state
 * @param sprite target guest
 * @param harness native harness executable
 * @returns guest command result
 */
async function listNativePlugins(
  sprite: Sprite,
  harness: 'claude' | 'codex',
): Promise<GuestCommandResult> {
  return runGuestResult(sprite, [
    '/usr/sbin/runuser',
    '-u',
    USER,
    '--',
    '/usr/bin/env',
    `PATH=${AGENT_PATH}`,
    harness,
    'plugin',
    'list',
    '--json',
  ]);
}

/**
 * asks the pinned SDK to report actual Claude/T3 initialization data
 * @param sprite target guest
 * @returns native initialization evidence when available
 */
async function inspectClaudeInitialization(
  sprite: Sprite,
): Promise<ClaudeInitialization | undefined> {
  if (
    !(await runBoundedIO(async () =>
      sprite.filesystem().exists('/opt/agent-sprite/claude-init-probe.js'),
    ))
  ) {
    return undefined;
  }
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
      '/opt/agent-sprite/claude-init-probe.js',
    ],
    { timeoutMs: 45_000 },
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
    modelCount: response.modelCount,
    commands: response.commands,
    agents: response.agents,
    loadedPlugins: response.loadedPlugins,
    selectedPluginsLoaded: response.selectedPluginsLoaded,
  };
}

/**
 * mints a new native T3 pairing credential without restarting its service
 * @param sprite target guest
 * @returns fresh expiring T3 pairing credential
 */
export async function pairT3(sprite: Sprite): Promise<T3Pairing> {
  const result = await runAsAgent(sprite, [
    't3',
    'pair',
    '--base-dir',
    `${HOME}/.t3`,
    '--ttl',
    '5m',
    '--label',
    'agent-sprite',
  ]);
  const outputLines = result.stdout.split('\n');
  const token = outputLines
    .find((line) => line.startsWith('Token:'))
    ?.slice('Token:'.length)
    .trim();
  const expiresAt = outputLines
    .find((line) => line.startsWith('Expires:'))
    ?.slice('Expires:'.length)
    .trim();
  if (!token) {
    throw new Error('T3 pairing command returned no parseable native token');
  }
  rememberSecret(token);

  return { token, expiresAt, raw: result.stdout };
}
