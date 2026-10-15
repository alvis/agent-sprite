import { CommandFault } from '#errors';
import { AWAKE_DEADLINE_MS } from '#integrations/guest/awake';
import { isRecord } from '#utilities/guards';

import type { AwakeHookCommand } from '#drivers/contracts';
import type { AwakeAction } from '#integrations/guest/awake';

/** one native hook event a harness reports to the idle governor */
export interface WorkHook {
  /** native hook event name */
  event: string;
  /** awake action the event reports */
  action: AwakeAction;
  /**
   * seconds the harness waits on the hook, which must not exceed the timeout
   * the harness honours for the event
   */
  timeoutSeconds: number;
}

/** the awake hooks open-agent installs in one harness */
export interface WorkHooks {
  /** harness whose sessions report, named as the awake source */
  harness: string;
  /** every event the harness reports, in the order the harness lists them */
  events: readonly WorkHook[];
}

/** what an owned hook merge, check or listing works on */
export interface WorkHookParams {
  /** the hooks open-agent owns in the harness */
  owned: WorkHooks;
  /** awake command the hooks invoke */
  command: AwakeHookCommand;
}

/**
 * longest a harness waits on an awake hook of a turn event, in seconds: the
 * awake command ends itself with status 0 within its run budget, which is
 * never more than AWAKE_DEADLINE_MS (8 s), so the harness never kills it
 * mid-write
 */
export const HOOK_TIMEOUT_SECONDS = 10;

/**
 * part of a hook's timeout kept free of the awake command's run budget for
 * the harness's shell and Node to start the command, in milliseconds
 */
export const HOOK_START_MARGIN_MS = 1_000;

const MILLISECONDS_PER_SECOND = 1_000;

/**
 * the turn events every harness reports: turn start holds the workstation,
 * each tool call is a heartbeat, and turn end releases the hold
 */
export const TURN_WORK_HOOKS: readonly WorkHook[] = [
  {
    event: 'UserPromptSubmit',
    action: 'hold-open',
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
  },
  {
    event: 'PreToolUse',
    action: 'heartbeat',
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
  },
  { event: 'Stop', action: 'hold-close', timeoutSeconds: HOOK_TIMEOUT_SECONDS },
];

/**
 * the awake command's run budget for a hook timeout: the timeout less
 * HOOK_START_MARGIN_MS, never more than AWAKE_DEADLINE_MS
 * @param timeoutSeconds seconds the harness waits on the hook
 * @returns the run budget, in milliseconds
 */
export function awakeBudgetMs(timeoutSeconds: number): number {
  return Math.min(
    AWAKE_DEADLINE_MS,
    timeoutSeconds * MILLISECONDS_PER_SECOND - HOOK_START_MARGIN_MS,
  );
}

/**
 * returns exact commands that open-agent installs and may trust in a harness;
 * the harness passes each event on standard input, so the awake command reads
 * the session identifier from there, and each command carries the run budget
 * that fits its event's timeout
 * @param params the owned hooks and the awake command they invoke
 * @returns exact event-to-command mapping, in the order of the owned events
 */
export function workHookCommands(
  params: WorkHookParams,
): Record<string, string> {
  return Object.fromEntries(
    params.owned.events.map((hook) => [hook.event, hookCommand(hook, params)]),
  );
}

/**
 * tells whether the harness's native hooks carry every exact awake command
 * open-agent installs, each under the event it belongs to
 * @param value native hook event map as the harness stores it
 * @param params the owned hooks and the awake command they invoke
 * @returns true only when every event has a command handler of exactly the
 * owned command line
 */
export function hasWorkHooks(value: unknown, params: WorkHookParams): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const owned = workHookCommands(params);

  return Object.entries(owned).every(([event, command]) => {
    const groups = value[event];

    return (
      Array.isArray(groups) &&
      groups.some(
        (group: unknown) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (handler: unknown) =>
              isRecord(handler) &&
              handler.type === 'command' &&
              handler.command === command,
          ),
      )
    );
  });
}

/**
 * writes one owned hook's command line
 * @param hook the event and its action and timeout
 * @param params the owned hooks and the awake command they invoke
 * @returns the exact command line
 */
function hookCommand(hook: WorkHook, params: WorkHookParams): string {
  const { owned, command } = params;

  return `${command.program} ${hook.action} --source ${owned.harness} --session - --budget-ms ${awakeBudgetMs(hook.timeoutSeconds)}`;
}

/**
 * copies the native hook event map after checking its shape
 * @param value current native hook event map
 * @returns shallow copy of the event map
 */
function nativeHooks(value: unknown): Record<string, unknown> {
  if (value !== undefined && !isRecord(value)) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'Native hook configuration is not an object',
    });
  }

  return { ...(value ?? {}) };
}

/**
 * reads the handler groups already registered for one event
 * @param hooks native hook event map
 * @param event hook event name
 * @returns registered handler groups, empty when none
 */
function eventGroups(hooks: Record<string, unknown>, event: string): unknown[] {
  const previous = hooks[event] ?? [];
  if (!Array.isArray(previous)) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Native ${event} hooks are not an array`,
    });
  }

  return previous;
}

/**
 * rejects native hooks that a later merge could not preserve, so a caller can
 * fail before writing any other part of the same native file
 * @param value current native hook event map
 * @param owned the hooks open-agent owns in the harness
 */
export function assertMergeableHooks(value: unknown, owned: WorkHooks): void {
  const hooks = nativeHooks(value);
  for (const { event } of owned.events) {
    eventGroups(hooks, event);
  }
}

/**
 * adds owned awake handlers, each with its event's timeout, while preserving
 * all existing native hooks
 * @param value current native hook event map
 * @param params the owned hooks and the awake command they invoke
 * @returns hook event map with idempotent owned handlers
 */
export function mergeWorkHooks(
  value: unknown,
  params: WorkHookParams,
): Record<string, unknown> {
  const hooks = nativeHooks(value);
  for (const hook of params.owned.events) {
    const { event, timeoutSeconds } = hook;
    const command = hookCommand(hook, params);
    const previous = eventGroups(hooks, event);
    const installed = previous.some(
      (group: unknown) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some(
          (handler: unknown) =>
            isRecord(handler) && handler.command === command,
        ),
    );
    hooks[event] = installed
      ? previous
      : [
          ...previous,
          {
            hooks: [
              {
                type: 'command',
                command,
                timeout: timeoutSeconds,
              },
            ],
          },
        ];
  }

  return hooks;
}
