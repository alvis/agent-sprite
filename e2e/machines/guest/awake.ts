import { CLAUDE_SETTINGS } from '#adapters/drivers/harnesses/claude/paths';
import { CODEX_HOOKS } from '#adapters/drivers/harnesses/codex/paths';
import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import { GUEST_ROOT } from '#adapters/guest/platform/layout';

import {
  AWAKE_DIRECTORY,
  GOVERNOR_REPORT,
  MANAGED_AWAKE_DIRECTORY,
  reportedGovernorState,
} from '../layout';
import { sleep } from '../timing';

import { asRoot } from './execution';

import type { GovernorHold } from '../idle';
import type { MachineProvider } from '../providers';

/** who owns the installed awake command and directories, and their modes */
export interface AwakeInstall {
  /** owner and mode of the awake command, as `<user> <mode>` */
  command: string;
  /** owner, group and mode of the shared awake directory, as `<user> <group> <mode>` */
  directory: string;
  /** owner, group and mode of the managed awake directory, as `<user> <group> <mode>` */
  managedDirectory: string;
}

/** what became of a hold root opened after the agent account tried to remove it */
export interface ManagedHoldCheck {
  /** exit status of the agent account's removal */
  removeExitCode: number;
  /** the managed holder files still holding after the removal; closed ones from earlier operations stay until pruned */
  managedHolders: number;
  /** the governor state record after an agent-account heartbeat, as root reads it */
  state: unknown;
}

/** one awake event the agent account sent and the state it left */
export interface AwakeStep {
  /** the command's exit status */
  exitCode: number;
  /** the governor state record after the event, as root reads it */
  state: unknown;
}

/**
 * reads how the awake command and its directories are installed
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the owner and mode of each
 */
export async function readAwakeInstall(
  provider: MachineProvider,
  name: string,
): Promise<AwakeInstall> {
  const [command, directory, managedDirectory] = await Promise.all([
    asRoot(provider, name, `find ${AWAKE_COMMAND} -printf '%u %m'`),
    asRoot(
      provider,
      name,
      `find ${GUEST_ROOT}/${AWAKE_DIRECTORY} -maxdepth 0 -printf '%u %g %m'`,
    ),
    asRoot(
      provider,
      name,
      `find ${GUEST_ROOT}/${MANAGED_AWAKE_DIRECTORY} -maxdepth 0 -printf '%u %g %m'`,
    ),
  ]);

  return { command, directory, managedDirectory };
}

/**
 * opens a hold as root, as a managed operation does, lets the agent account
 * try to remove every managed holder file, and reads the state an
 * agent-account heartbeat then records; the hold is closed after
 * @param provider selected provider
 * @param name exact workstation name
 * @param session the session the events report
 * @returns the removal's exit status, the managed holders left and the state
 */
export async function checkManagedHold(
  provider: MachineProvider,
  name: string,
  session: string,
): Promise<ManagedHoldCheck> {
  const managed = `${GUEST_ROOT}/${MANAGED_AWAKE_DIRECTORY}`;
  const holder = `--source e2e-root --session ${session}`;
  await asRoot(provider, name, `${AWAKE_COMMAND} hold-open ${holder}`);
  // root's shell expands the names; the agent account then removes them
  const removeExitCode = Number(
    (
      await asRoot(
        provider,
        name,
        `runuser -u agent -- rm -f ${managed}/h-*.json 2>/dev/null; echo $?`,
      )
    ).trim(),
  );
  const managedHolders = Number(
    (
      await asRoot(
        provider,
        name,
        `grep -l holdExpiresAt ${managed}/h-*.json 2>/dev/null | wc -l`,
      )
    ).trim(),
  );
  await asRoot(
    provider,
    name,
    `runuser -u agent -- ${AWAKE_COMMAND} heartbeat --source e2e --session ${session}`,
  );
  const state: unknown = reportedGovernorState(
    await asRoot(provider, name, GOVERNOR_REPORT),
  );
  await asRoot(provider, name, `${AWAKE_COMMAND} hold-close ${holder}`);

  return { removeExitCode, managedHolders, state };
}

/**
 * sends a heartbeat, opens a hold and closes it as the agent account, as a
 * harness hook does, reading the governor state after each event
 * @param provider selected provider
 * @param name exact workstation name
 * @param session the session the events report
 * @returns each event's exit status and the state it left
 */
export async function sendAwakeEvents(
  provider: MachineProvider,
  name: string,
  session: string,
): Promise<AwakeStep[]> {
  const steps: AwakeStep[] = [];
  for (const action of ['heartbeat', 'hold-open', 'hold-close']) {
    const status = await asRoot(
      provider,
      name,
      `runuser -u agent -- ${AWAKE_COMMAND} ${action} --source e2e --session ${session}; echo $?`,
    );
    const state: unknown = reportedGovernorState(
      await asRoot(provider, name, GOVERNOR_REPORT),
    );
    steps.push({ exitCode: Number(status.trim()), state });
  }

  return steps;
}

/** the awake commands the hook files of the two harnesses list, by event */
export interface AwakeHooks {
  /** Claude Code's settings */
  claude: Record<string, string[]>;
  /** Codex's hooks file */
  codex: Record<string, string[]>;
}

/** one hook event the agent account sent through standard input */
export interface HookStep {
  /** the awake action the hook runs */
  action: string;
  /** the command's exit status */
  exitCode: number;
  /** holds still open after the event */
  openHolds: number;
  /** the deadline the governor records, absent when nothing keeps the workstation awake */
  deadline: string | undefined;
  /** when the governor last saw a heartbeat */
  lastHeartbeat: string | undefined;
  /** idle minutes the governor applies */
  idleTimeoutMinutes: number;
  /** when the Sprite task expires, absent when the Sprite has no task */
  taskExpiresAt: string | undefined;
}

/** the part of the hook file the proof reads */
interface HookFile {
  hooks?: Record<
    string,
    Array<{ hooks?: Array<{ command?: string }> }> | undefined
  >;
}

/**
 * reads the awake hook commands of both harnesses from their files in the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns each harness's awake commands by event
 */
export async function readAwakeHooks(
  provider: MachineProvider,
  name: string,
): Promise<AwakeHooks> {
  const read = async (path: string): Promise<Record<string, string[]>> => {
    const file = JSON.parse(
      await asRoot(provider, name, `cat ${path}`),
    ) as HookFile;

    return Object.fromEntries(
      Object.entries(file.hooks ?? {}).map(([event, groups]) => [
        event,
        (groups ?? [])
          .flatMap((group) => group.hooks ?? [])
          .map((hook) => hook.command ?? '')
          .filter((command) => command.startsWith(AWAKE_COMMAND)),
      ]),
    );
  };

  return {
    claude: await read(CLAUDE_SETTINGS),
    codex: await read(CODEX_HOOKS),
  };
}

/** the state fields a hook step reports */
interface HookState {
  openHolds: number;
  deadline?: string;
  lastHeartbeat?: string;
  idleTimeoutMinutes: number;
}

/**
 * sends each hook event the way a harness does, as the agent account with the
 * event's JSON on standard input, and reads what the governor and the Sprite
 * then hold
 * @param provider selected provider
 * @param name exact workstation name
 * @param events what to send
 * @param events.harness the harness the events come from
 * @param events.session the session the events name
 * @param events.actions the awake actions to send, in order
 * @param events.pausesMs how long to wait before sending an action, by action
 * @returns each event's exit status and the resulting state
 */
export async function sendHookEvents(
  provider: MachineProvider,
  name: string,
  events: {
    harness: string;
    session: string;
    actions: readonly string[];
    pausesMs?: Partial<Record<string, number>>;
  },
): Promise<HookStep[]> {
  const { harness, session, actions, pausesMs = {} } = events;
  const steps: HookStep[] = [];
  const event = JSON.stringify({ session_id: session, hook_event_name: 'x' });
  for (const action of actions) {
    await sleep(pausesMs[action] ?? 0);
    const status = await asRoot(
      provider,
      name,
      `printf '%s' '${event}' | runuser -u agent -- ${AWAKE_COMMAND} ${action} --source ${harness} --session -; echo $?`,
    );
    const state = reportedGovernorState(
      await asRoot(provider, name, GOVERNOR_REPORT),
    ) as HookState;
    steps.push({
      action,
      exitCode: Number(status.trim()),
      openHolds: state.openHolds,
      deadline: state.deadline,
      lastHeartbeat: state.lastHeartbeat,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      taskExpiresAt: await provider.readAwakeTask(name),
    });
  }

  return steps;
}

/**
 * records which sources hold the workstation awake while an operation runs
 * @param provider selected provider
 * @param name exact workstation name
 * @param operation the operation to watch
 * @returns the operation's result, every holder source seen meanwhile, how
 * many distinct expiries each source's hold showed (a hold that is refreshed
 * shows more than one) and the holds still open once it ended
 */
export async function watchHolders<T>(
  provider: MachineProvider,
  name: string,
  operation: () => Promise<T>,
): Promise<{
  result: T;
  sources: string[];
  expiries: Record<string, number>;
  openHoldsAfter: number;
}> {
  const sources = new Set<string>();
  const expiries = new Map<string, Set<string>>();
  const readState = async (): Promise<{
    holds: GovernorHold[];
    openHolds: number;
  }> =>
    reportedGovernorState(await asRoot(provider, name, GOVERNOR_REPORT)) as {
      holds: GovernorHold[];
      openHolds: number;
    };
  const watching = { isActive: true };
  const watcher = (async () => {
    while (watching.isActive) {
      for (const { source, expiresAt } of (await readState()).holds) {
        sources.add(source);
        expiries.set(
          source,
          (expiries.get(source) ?? new Set()).add(expiresAt),
        );
      }
    }
  })();
  try {
    const result = await operation();
    watching.isActive = false;
    await watcher;

    return {
      result,
      sources: [...sources].sort(),
      expiries: Object.fromEntries(
        [...expiries].map(([source, seen]) => [source, seen.size]),
      ),
      openHoldsAfter: (await readState()).openHolds,
    };
  } finally {
    watching.isActive = false;
    await watcher;
  }
}
