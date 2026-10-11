import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from './records.js';
import { openAuthenticatedSocket, callRpc } from './t3-provider-probe/rpc.js';

import type { WebSocket } from 'ws';

/** validated native instance identity with additional discovery fields */
interface NativeProvider extends Record<string, unknown> {
  instanceId: string;
  driver: string;
  enabled: boolean;
  checkedAt: string;
}
/** non-secret native skill evidence */
interface SkillEvidence {
  name: string;
  path: string;
  enabled: boolean;
  scope?: string;
}
/** fresh supported provider facts returned to the host */
interface ProviderEvidence {
  instanceId: string;
  driver: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  version?: string;
  checkedAt: string;
  commands: string[];
  skills: SkillEvidence[];
}
/** exact previous and current observations for one workspace refresh */
interface FreshProviderParams {
  previous: NativeProvider;
  current?: NativeProvider;
  startedAt: number;
  serverCwd: unknown;
}
/** bounded running-service probe result */
interface ProviderInspection {
  ok: boolean;
  providers: ProviderEvidence[];
  reason?: string;
  scope: string;
  workspace: string;
  limits: { ordinaryThreadStartup: string; runtimeHooks: string; mcp: string };
}

const executeFile = promisify(execFile);
const home = '/home/agent';
const baseDirectory = `${home}/.t3`;
const cliTimeoutMs = 15_000;
const maxResponseBytes = 1_048_576;
const supportedDrivers = new Set(['claudeAgent', 'codex']);
const evidenceLimits = {
  ordinaryThreadStartup: 'unverified',
  runtimeHooks: 'unverified',
  mcp: 'unverified',
};

const result = await inspectRunningT3();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;

/**
 * observes fresh provider discovery inside the managed T3 service without a turn
 * @returns bounded non-secret discovery evidence
 */
async function inspectRunningT3(): Promise<ProviderInspection> {
  let sessionId: string | undefined;
  let socket: WebSocket | undefined;
  let evidence: Pick<ProviderInspection, 'ok' | 'providers' | 'reason'>;
  try {
    const issued: unknown = JSON.parse(
      await runNativeT3([
        'auth',
        'session',
        'issue',
        '--base-dir',
        baseDirectory,
        '--ttl',
        '5m',
        '--label',
        'agent-sprite-config-probe',
        '--json',
      ]),
    );
    if (isRecord(issued) && typeof issued.sessionId === 'string') {
      sessionId = issued.sessionId;
    }
    if (
      !sessionId ||
      !isRecord(issued) ||
      typeof issued.token !== 'string' ||
      !issued.token
    ) {
      throw new Error('native administrative session response is invalid');
    }
    socket = await openAuthenticatedSocket(issued.token);
    const providers = await inspectProviders(socket);
    evidence = { ok: true, providers };
  } catch {
    evidence = {
      ok: false,
      providers: [],
      reason: 'provider-discovery-failed',
    };
  } finally {
    socket?.terminate();
    if (!(await revokeSession(sessionId))) {
      evidence = {
        ok: false,
        providers: [],
        reason: 'session-revocation-failed',
      };
    }
  }

  return {
    ...evidence,
    scope: 't3-provider-discovery',
    workspace: home,
    limits: evidenceLimits,
  };
}

/**
 * revokes an issued native session without disclosing authentication output
 * @param sessionId native session identity when issuance succeeded
 * @returns whether no issued session remains after native cleanup
 */
async function revokeSession(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) {
    return true;
  }
  try {
    await runNativeT3([
      'auth',
      'session',
      'revoke',
      sessionId,
      '--base-dir',
      baseDirectory,
    ]);

    return true;
  } catch {
    return false;
  }
}

/**
 * captures supported native authentication output privately with a finite timeout
 * @param arguments_ native CLI arguments
 * @returns captured output for internal use only
 */
async function runNativeT3(arguments_: string[]): Promise<string> {
  const result = await executeFile(`${home}/.local/bin/t3`, arguments_, {
    cwd: home,
    env: { ...process.env, HOME: home },
    timeout: cliTimeoutMs,
    maxBuffer: maxResponseBytes,
  });

  return result.stdout;
}

/**
 * refreshes enabled native instances and rejects cached discovery responses
 * @param socket authenticated T3 connection
 * @returns fresh narrowed provider snapshots
 */
async function inspectProviders(
  socket: WebSocket,
): Promise<ProviderEvidence[]> {
  const config = await callRpc(socket, {
    id: '0',
    tag: 'server.getConfig',
    payload: {},
  });
  const initial = readProviderList(config);
  const selected = initial.filter(
    (provider) =>
      supportedDrivers.has(provider.driver) && provider.enabled === true,
  );
  const evidence: ProviderEvidence[] = [];
  for (const [index, provider] of selected.entries()) {
    const startedAt = Date.now();
    const refreshed = readProviderList(
      await callRpc(socket, {
        id: String(index + 1),
        tag: 'server.refreshProviders',
        payload: { instanceId: provider.instanceId, cwd: home, fresh: true },
      }),
    );
    const current = refreshed.find(
      (candidate) => candidate.instanceId === provider.instanceId,
    );
    evidence.push(
      narrowFreshProvider({
        previous: provider,
        current,
        startedAt,
        serverCwd: config.cwd,
      }),
    );
  }

  return evidence;
}

/**
 * validates the native instance inventory before targeting a refresh
 * @param response decoded native RPC result
 * @returns validated provider records
 */
function readProviderList(response: unknown): NativeProvider[] {
  if (!isRecord(response) || !Array.isArray(response.providers)) {
    throw new Error('T3 provider inventory is invalid');
  }

  return response.providers.map((provider: unknown) => {
    if (
      !isRecord(provider) ||
      typeof provider.instanceId !== 'string' ||
      typeof provider.driver !== 'string' ||
      typeof provider.enabled !== 'boolean' ||
      typeof provider.checkedAt !== 'string'
    ) {
      throw new Error('T3 provider inventory is invalid');
    }

    return {
      ...provider,
      instanceId: provider.instanceId,
      driver: provider.driver,
      enabled: provider.enabled,
      checkedAt: provider.checkedAt,
    };
  });
}

/**
 * selects the exact fresh workspace snapshot and excludes arbitrary native fields
 * @param params previous and refreshed snapshots with request timing
 * @returns non-secret fresh provider discovery evidence
 */
function narrowFreshProvider(params: FreshProviderParams): ProviderEvidence {
  const { previous, current, startedAt, serverCwd } = params;
  if (current?.driver !== previous.driver) {
    throw new Error('T3 provider identity changed during discovery');
  }
  const snapshot =
    workspaceSnapshot(current) ?? (serverCwd === home ? current : undefined);
  const previousSnapshot = workspaceSnapshot(previous) ?? previous;
  const checkedAt =
    typeof snapshot?.checkedAt === 'string'
      ? Date.parse(snapshot.checkedAt)
      : NaN;
  if (
    !snapshot ||
    typeof snapshot.checkedAt !== 'string' ||
    !Number.isFinite(checkedAt) ||
    checkedAt < startedAt ||
    checkedAt <=
      Date.parse(
        typeof previousSnapshot.checkedAt === 'string'
          ? previousSnapshot.checkedAt
          : '',
      )
  ) {
    throw new Error('T3 did not return fresh workspace discovery');
  }
  if (
    typeof current.installed !== 'boolean' ||
    typeof current.status !== 'string' ||
    !Array.isArray(snapshot.slashCommands) ||
    !Array.isArray(snapshot.skills)
  ) {
    throw new Error('T3 provider discovery shape is invalid');
  }

  return {
    instanceId: current.instanceId,
    driver: current.driver,
    enabled: current.enabled,
    installed: current.installed,
    status: current.status,
    version: typeof current.version === 'string' ? current.version : undefined,
    checkedAt: snapshot.checkedAt,
    commands: snapshot.slashCommands.map(commandName),
    skills: snapshot.skills.map(narrowSkill),
  };
}

/**
 * locates only the requested workspace's native discovery snapshot
 * @param provider native provider record
 * @returns matching workspace snapshot
 */
function workspaceSnapshot(
  provider: NativeProvider,
): Record<string, unknown> | undefined {
  return Array.isArray(provider.workspaceSnapshots)
    ? provider.workspaceSnapshots
        .filter(isRecord)
        .find((snapshot) => isRecord(snapshot) && snapshot.cwd === home)
    : undefined;
}

/**
 * narrows a native command to its non-secret invocation name
 * @param command native slash command
 * @returns exact native invocation identifier
 */
function commandName(command: unknown): string {
  if (!isRecord(command) || typeof command.name !== 'string') {
    throw new Error('T3 command entry is invalid');
  }

  return command.name;
}

/**
 * narrows native skill visibility to exact identity, path, and enablement
 * @param skill native skill entry
 * @returns bounded non-secret skill fields
 */
function narrowSkill(skill: unknown): SkillEvidence {
  if (
    !isRecord(skill) ||
    typeof skill.name !== 'string' ||
    typeof skill.path !== 'string' ||
    typeof skill.enabled !== 'boolean'
  ) {
    throw new Error('T3 skill entry is invalid');
  }

  return {
    name: skill.name,
    path: skill.path,
    enabled: skill.enabled,
    scope: typeof skill.scope === 'string' ? skill.scope : undefined,
  };
}
