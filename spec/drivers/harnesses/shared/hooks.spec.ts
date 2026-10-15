import { describe, expect, it } from 'vitest';

import { AWAKE_HOOK_COMMAND } from '#core/harnesses';
import { CLAUDE_WORK_HOOKS } from '#drivers/harnesses/claude/hooks';
import { CODEX_WORK_HOOKS } from '#drivers/harnesses/codex/hooks';
import {
  assertMergeableHooks,
  awakeBudgetMs,
  HOOK_START_MARGIN_MS,
  hasWorkHooks,
  mergeWorkHooks,
  workHookCommands,
} from '#drivers/harnesses/shared/hooks';
import { hookInputWaitMs } from '#guest/idle/hook-input';
import { AWAKE_COMMAND, AWAKE_DEADLINE_MS } from '#integrations/guest/awake';

const COMMAND = { program: '/opt/open-agent/guest/awake.sh' };
const CLAUDE = { owned: CLAUDE_WORK_HOOKS, command: COMMAND };
const CODEX = { owned: CODEX_WORK_HOOKS, command: COMMAND };

/**
 * the timeout of every owned handler in a merged hook map, by event
 * @param merged native hook event map after the merge
 * @returns each event's handler timeouts
 */
function timeoutsOf(merged: Record<string, unknown>): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(merged).map(([event, groups]) => [
      event,
      (groups as Array<{ hooks: Array<{ timeout: number }> }>).flatMap(
        ({ hooks }) => hooks.map(({ timeout }) => timeout),
      ),
    ]),
  );
}

describe('fn:workHookCommands', () => {
  it('should map the Claude turn and session events to the awake actions within an 8-second budget', () => {
    expect(workHookCommands(CLAUDE)).toEqual({
      UserPromptSubmit: `${COMMAND.program} hold-open --source claude --session - --budget-ms 8000`,
      PreToolUse: `${COMMAND.program} heartbeat --source claude --session - --budget-ms 8000`,
      Stop: `${COMMAND.program} hold-close --source claude --session - --budget-ms 8000`,
      SessionEnd: `${COMMAND.program} hold-close --source claude --session - --budget-ms 8000`,
    });
  });

  it('should release the Codex hold on session end and interrupt within a 2-second budget', () => {
    expect(workHookCommands(CODEX)).toEqual({
      UserPromptSubmit: `${COMMAND.program} hold-open --source codex --session - --budget-ms 8000`,
      PreToolUse: `${COMMAND.program} heartbeat --source codex --session - --budget-ms 8000`,
      Stop: `${COMMAND.program} hold-close --source codex --session - --budget-ms 8000`,
      SessionEnd: `${COMMAND.program} hold-close --source codex --session - --budget-ms 2000`,
      Interrupt: `${COMMAND.program} hold-close --source codex --session - --budget-ms 2000`,
    });
  });

  it('should call the awake command the guest installs', () => {
    expect(AWAKE_HOOK_COMMAND.program).toBe(AWAKE_COMMAND);
    expect(AWAKE_COMMAND).toBe('/opt/open-agent/guest/awake.sh');
  });
});

describe('fn:awakeBudgetMs', () => {
  it('should leave the start margin of a short timeout free and cap a long one at the command deadline', () => {
    expect([awakeBudgetMs(3), awakeBudgetMs(10)]).toEqual([
      3_000 - HOOK_START_MARGIN_MS,
      AWAKE_DEADLINE_MS,
    ]);
  });
});

describe('harness hook timeouts', () => {
  it('should give each Claude event a 10-second timeout, which Claude Code honours on every event', () => {
    expect(timeoutsOf(mergeWorkHooks({}, CLAUDE))).toEqual({
      UserPromptSubmit: [10],
      PreToolUse: [10],
      Stop: [10],
      SessionEnd: [10],
    });
  });

  it('should keep the Codex session-end and interrupt timeouts within the 3-second cap Codex enforces', () => {
    expect(timeoutsOf(mergeWorkHooks({}, CODEX))).toEqual({
      UserPromptSubmit: [10],
      PreToolUse: [10],
      Stop: [10],
      SessionEnd: [3],
      Interrupt: [3],
    });
  });

  it.each([CLAUDE_WORK_HOOKS, CODEX_WORK_HOOKS])(
    'should fit the awake run budget and its input wait inside every $harness timeout with the start margin',
    ({ events }) => {
      const overruns = events.filter(({ timeoutSeconds }) => {
        const budget = awakeBudgetMs(timeoutSeconds);

        return (
          budget + HOOK_START_MARGIN_MS > timeoutSeconds * 1_000 ||
          hookInputWaitMs(budget) >= budget
        );
      });

      expect(overruns).toEqual([]);
    },
  );
});

describe('fn:mergeWorkHooks', () => {
  const foreign = { hooks: [{ type: 'command', command: 'user-command' }] };

  it('should add the owned handlers beside foreign ones and stay idempotent', () => {
    const first = mergeWorkHooks(
      { Stop: [foreign], CustomEvent: [foreign] },
      CODEX,
    );
    const repeated = mergeWorkHooks(first, CODEX);
    const owned = (event: string, timeout: number): unknown => ({
      hooks: [
        {
          type: 'command',
          command: workHookCommands(CODEX)[event],
          timeout,
        },
      ],
    });

    expect(first).toEqual({
      CustomEvent: [foreign],
      UserPromptSubmit: [owned('UserPromptSubmit', 10)],
      PreToolUse: [owned('PreToolUse', 10)],
      Stop: [foreign, owned('Stop', 10)],
      SessionEnd: [owned('SessionEnd', 3)],
      Interrupt: [owned('Interrupt', 3)],
    });
    expect(repeated).toEqual(first);
  });
});

describe('fn:assertMergeableHooks', () => {
  it('should refuse hooks a merge could not preserve', () => {
    expect(() => {
      assertMergeableHooks({ Interrupt: 'not-a-list' }, CODEX_WORK_HOOKS);
    }).toThrow('Native Interrupt hooks are not an array');
  });
});

describe('fn:hasWorkHooks', () => {
  const installed = mergeWorkHooks(
    { Stop: [{ hooks: [{ type: 'command', command: 'user-command' }] }] },
    CODEX,
  );

  it('should accept hooks carrying every exact command beside foreign ones', () => {
    expect(hasWorkHooks(installed, CODEX)).toBe(true);
  });

  it.each([
    ['no hooks', undefined],
    ['a hook list that is not an object', []],
    ['an empty hook map', {}],
  ])('should refuse %s', (_, hooks) => {
    expect(hasWorkHooks(hooks, CODEX)).toBe(false);
  });

  it.each([
    'UserPromptSubmit',
    'PreToolUse',
    'Stop',
    'SessionEnd',
    'Interrupt',
  ])('should refuse Codex hooks missing the %s command', (event) => {
    const { [event]: _removed, ...rest } = installed;

    expect(hasWorkHooks(rest, CODEX)).toBe(false);
  });

  it('should refuse a command for another harness or another action', () => {
    expect(hasWorkHooks(installed, CLAUDE)).toBe(false);
    expect(
      hasWorkHooks(
        {
          ...installed,
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: workHookCommands(CODEX).UserPromptSubmit,
                },
              ],
            },
          ],
        },
        CODEX,
      ),
    ).toBe(false);
  });
});
