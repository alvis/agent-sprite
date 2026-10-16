import {
  ensurePrivateDirectory,
  writeOwnedFile,
} from '#integrations/guest/account';
import { readJsonObject } from '#integrations/native/configuration';

import {
  HOOK_TIMEOUT_SECONDS,
  mergeWorkHooks,
  TURN_WORK_HOOKS,
} from '../shared/hooks';

import { CLAUDE_CONFIG_DIR, CLAUDE_SETTINGS } from './paths';

import type {
  AwakeHookCommand,
  HarnessHookInstaller,
} from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { WorkHooks } from '../shared/hooks';

/**
 * the awake hooks of Claude Code. Claude Code honours a command hook's
 * `timeout` on every event; `SessionEnd` hooks share a 1.5-second budget that
 * a per-hook `timeout` in the settings files raises, up to 60 seconds
 * (https://code.claude.com/docs/en/hooks, "SessionEnd"), so 10 seconds holds
 * on each event
 */
export const CLAUDE_WORK_HOOKS: WorkHooks = {
  harness: 'claude',
  events: [
    ...TURN_WORK_HOOKS,
    {
      event: 'SessionEnd',
      action: 'hold-close',
      timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    },
  ],
};

/**
 * merges open-agent's awake hooks into Claude user settings
 * @param guest target guest
 * @param command awake command the hooks invoke
 */
async function installClaudeHooks(
  guest: GuestChannel,
  command: AwakeHookCommand,
): Promise<void> {
  await ensurePrivateDirectory(guest, CLAUDE_CONFIG_DIR);
  const current = await readJsonObject(guest, CLAUDE_SETTINGS);
  const next = {
    ...current,
    hooks: mergeWorkHooks(current.hooks, {
      owned: CLAUDE_WORK_HOOKS,
      command,
    }),
  };
  await writeOwnedFile(
    guest,
    CLAUDE_SETTINGS,
    `${JSON.stringify(next, null, 2)}\n`,
  );
}

/** idle-governor hooks of Claude Code */
export const claudeHooks: HarnessHookInstaller = {
  install: installClaudeHooks,
};
