import {
  ensurePrivateDirectory,
  readJsonObject,
  writeOwnedFile,
} from '#integrations/native/configuration';

import {
  mergeWorkHooks,
  TURN_WORK_HOOKS,
  workHookCommands,
} from '../shared/hooks.js';

import { trustCodexHooks } from './hook-trust.js';
import { CODEX_HOME, CODEX_HOOKS } from './paths.js';

import type {
  AwakeHookCommand,
  HarnessHookInstaller,
} from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { WorkHooks } from '../shared/hooks.js';

/**
 * longest Codex waits on a `SessionEnd` or `Interrupt` hook, in seconds:
 * Codex clamps their `timeout` to 1 to 3 seconds, defaulting to 1, and keeps
 * other events' `timeout` as set (openai/codex rust-v0.162.1,
 * codex-rs/hooks/src/engine/discovery.rs `normalize_command_hook` and
 * codex-rs/hooks/src/events/session_end.rs `SESSION_END_MAX_TIMEOUT_SEC`)
 */
const CODEX_TEARDOWN_HOOK_TIMEOUT_SECONDS = 3;

/**
 * the awake hooks of Codex. Codex runs `Interrupt`, whose event carries
 * `session_id`, when a turn is aborted instead of `Stop`, so it releases the
 * turn's hold too (codex-rs/core/src/hook_runtime.rs and
 * codex-rs/hooks/schema/generated/interrupt.command.input.schema.json)
 */
export const CODEX_WORK_HOOKS: WorkHooks = {
  harness: 'codex',
  events: [
    ...TURN_WORK_HOOKS,
    {
      event: 'SessionEnd',
      action: 'hold-close',
      timeoutSeconds: CODEX_TEARDOWN_HOOK_TIMEOUT_SECONDS,
    },
    {
      event: 'Interrupt',
      action: 'hold-close',
      timeoutSeconds: CODEX_TEARDOWN_HOOK_TIMEOUT_SECONDS,
    },
  ],
};

/**
 * installs and narrowly trusts only open-agent's own user-level Codex hooks
 * @param guest target guest
 * @param command awake command the hooks invoke
 */
async function installCodexHooks(
  guest: GuestChannel,
  command: AwakeHookCommand,
): Promise<void> {
  await ensurePrivateDirectory(guest, CODEX_HOME);
  const existingHooks = await readJsonObject(guest, CODEX_HOOKS);
  await writeOwnedFile(
    guest,
    CODEX_HOOKS,
    `${JSON.stringify(
      {
        ...existingHooks,
        hooks: mergeWorkHooks(existingHooks.hooks, {
          owned: CODEX_WORK_HOOKS,
          command,
        }),
      },
      null,
      2,
    )}\n`,
  );
  await trustCodexHooks(
    guest,
    workHookCommands({ owned: CODEX_WORK_HOOKS, command }),
  );
}

/** idle-governor hooks of Codex */
export const codexHooks: HarnessHookInstaller = {
  install: installCodexHooks,
};
