import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import { registry } from '#composition/registry';

import { readAwakeHooks, sendHookEvents } from '../../guest';
import { SECOND_MS } from '../../timing';

import type { CreatedLifecycle } from '../context';

const TASK_EXPIRY_TOLERANCE_MS = 3000;
const MINUTE_MS = 60_000;
const STANDARD_HOOK_BUDGET_MS = 8_000;
const CLOSING_HOOK_BUDGET_MS = 2_000;

/**
 * checks both harnesses' installed awake hooks
 * @param context run drivers and prior observations
 */
export async function checkHookDefinitions(
  context: CreatedLifecycle,
): Promise<void> {
  const { name, expect, harness } = context;
  const { provider } = harness;
  const hooks = await readAwakeHooks(provider, name);
  const awake = (
    harness: string,
    action: string,
    budgetMs: number,
  ): string[] => [
    `${AWAKE_COMMAND} ${action} --source ${harness} --session - --budget-ms ${budgetMs}`,
  ];
  const turnHooks = (harness: string): Record<string, string[]> => ({
    UserPromptSubmit: awake(harness, 'hold-open', STANDARD_HOOK_BUDGET_MS),
    PreToolUse: awake(harness, 'heartbeat', STANDARD_HOOK_BUDGET_MS),
    Stop: awake(harness, 'hold-close', STANDARD_HOOK_BUDGET_MS),
  });

  expect(hooks.claude).toMatchObject({
    ...turnHooks('claude'),
    SessionEnd: awake('claude', 'hold-close', STANDARD_HOOK_BUDGET_MS),
  });
  // Codex waits at most 3 s on SessionEnd and Interrupt hooks
  expect(hooks.codex).toMatchObject({
    ...turnHooks('codex'),
    SessionEnd: awake('codex', 'hold-close', CLOSING_HOOK_BUDGET_MS),
    Interrupt: awake('codex', 'hold-close', CLOSING_HOOK_BUDGET_MS),
  });

  // a hook event arrives as JSON on standard input; the Sprite's own
  // task follows the governor's deadline, and the agent account reaches
}

/**
 * checks hold events against governor and provider deadlines
 * @param context run drivers and prior observations
 */
export async function checkHookEvents(
  context: CreatedLifecycle,
): Promise<void> {
  const { name, expect, harness } = context;
  const { provider } = harness;
  const hasNativeDeadline =
    registry.providers[provider.name].capabilities.keepAwakeMode ===
    'native-deadline';
  const hookSteps = await sendHookEvents(provider, name, {
    harness: 'claude',
    session: name,
    actions: ['hold-open', 'heartbeat', 'hold-close'],
    // longer than the expiry tolerance, so a heartbeat that moved
    // nothing could not pass for one that did
    pausesMs: { heartbeat: TASK_EXPIRY_TOLERANCE_MS + SECOND_MS },
  });
  const [opened, refreshed, closed] = hookSteps;

  expect(
    hookSteps.map(({ action, exitCode, openHolds }) => ({
      action,
      exitCode,
      openHolds,
    })),
  ).toEqual([
    { action: 'hold-open', exitCode: 0, openHolds: 1 },
    { action: 'heartbeat', exitCode: 0, openHolds: 1 },
    { action: 'hold-close', exitCode: 0, openHolds: 0 },
  ]);
  // a heartbeat sent after more than the tolerance moves the deadline,
  // and the provider's own task with it, strictly later, and closing the
  // last hold leaves the deadline at the last heartbeat plus the idle timeout
  expect(Date.parse(refreshed!.deadline ?? '')).toBeGreaterThan(
    Date.parse(opened!.deadline ?? ''),
  );
  expect(
    hookSteps.map(({ taskExpiresAt, deadline }) =>
      hasNativeDeadline
        ? Math.abs(
            Date.parse(taskExpiresAt ?? '') - Date.parse(deadline ?? ''),
          ) <= TASK_EXPIRY_TOLERANCE_MS
        : taskExpiresAt === undefined,
    ),
  ).toEqual([true, true, true]);
  expect(
    Date.parse(refreshed!.taskExpiresAt ?? '') >
      Date.parse(opened!.taskExpiresAt ?? ''),
  ).toBe(hasNativeDeadline);
  expect(
    Date.parse(closed!.deadline ?? '') -
      Date.parse(closed!.lastHeartbeat ?? ''),
  ).toBe(closed!.idleTimeoutMinutes * MINUTE_MS);
}
