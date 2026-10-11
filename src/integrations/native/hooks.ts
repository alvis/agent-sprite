import { CommandFault } from '#errors';

import { isRecord } from './configuration.js';

const HOOK_SCRIPT = '/opt/agent-sprite/guest-task-hold.js';
const NODE = '/opt/agent-sprite/node/bin/node';
const HOOK_TIMEOUT_SECONDS = 10;
const SESSION_END_TIMEOUT_SECONDS = 3;

/**
 * returns exact commands that agent-sprite installs and may trust in Codex
 * @param harness native harness whose sessions own the work hold
 * @returns exact event-to-command mapping
 */
export function workHookCommands(
  harness: 'claude' | 'codex',
): Record<string, string> {
  return {
    UserPromptSubmit: `${NODE} ${HOOK_SCRIPT} hook acquire ${harness}`,
    PreToolUse: `${NODE} ${HOOK_SCRIPT} hook acquire ${harness}`,
    Stop: `${NODE} ${HOOK_SCRIPT} hook release ${harness}`,
    SessionEnd: `${NODE} ${HOOK_SCRIPT} hook release ${harness}`,
  };
}

/**
 * adds owned work-hold handlers while preserving all existing native hooks
 * @param value current native hook event map
 * @param harness harness whose sessions own the holds
 * @returns hook event map with idempotent owned handlers
 */
export function mergeWorkHooks(
  value: unknown,
  harness: 'claude' | 'codex',
): Record<string, unknown> {
  if (value !== undefined && !isRecord(value)) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'Native hook configuration is not an object',
    });
  }
  const hooks = { ...(value ?? {}) } as Record<string, unknown>;
  for (const [event, command] of Object.entries(workHookCommands(harness))) {
    const previous = hooks[event] ?? [];
    if (!Array.isArray(previous)) {
      throw new CommandFault({
        code: 'INPUT',
        message: `Native ${event} hooks are not an array`,
      });
    }
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
                timeout:
                  event === 'SessionEnd'
                    ? SESSION_END_TIMEOUT_SECONDS
                    : HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        ];
  }

  return hooks;
}
